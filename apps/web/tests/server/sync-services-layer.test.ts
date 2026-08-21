import { env } from "cloudflare:test";
import type { Balance } from "@folio/connectors-basic";
import { AccountStore as DbAccountStore } from "@folio/db";
import { Account, BalanceSource, AccountStore as SyncAccountStore } from "@folio/sync";
import { Cause, Effect, Exit, Layer, Option } from "effect";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { runRequest } from "../../src/lib/server/oracle";
import { syncServicesLayer } from "../../src/lib/server/sync/deps";
import { dbFor } from "./db-effect";

// `syncServicesLayer` —— app 侧对 `@folio/sync` 那四个能力的接线(#403 片 2)。
//
// 为什么单独有这个文件:别处的用例测的是**编排**(mint 认得对不对、重试退避、失败隔离),
// 它们把「取余额」以外的东西当背景。而这一层本身才是 app 这边的活儿 —— 四个 Tag 的接线、
// seed 收集器的共享、估值模式的惰性读、**db 的 defect 往 `SyncDepError` 的翻译**。
// 最后那条尤其要钉:少了它,一个用户的 D1 抖动会掀掉整轮 cron,而那是静默的。
//
// 走**真 D1**(Miniflare)与**真参考层**,只把「取余额」那一个能力换成假的 —— 那是唯一会出网的
// 一步,其余都要如实跑,否则测的就不是接线了。

const USER = "user-sync-services-layer";

async function resetUser(): Promise<void> {
  await env.DB.prepare("DELETE FROM user WHERE id = ?").bind(USER).run();
  const now = Date.now();
  await env.DB.prepare(
    "INSERT INTO user (id, name, email, email_verified, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
  )
    .bind(USER, USER, `${USER}@example.com`, 0, now, now)
    .run();
}

beforeEach(async () => {
  await resetUser();
  // 这条路按设计不出网(认币走本地映射表 / 目录);真出网了就让用例响一声。
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    throw new Error(`不该出网,却请求了 ${String(input)}`);
  });
});

// 假的「取余额」:其余三个能力仍是真接线。`Effect.provide` 由内往外解析,所以这一层先满足
// `BalanceSource`,`syncServicesLayer` 里那份就轮不到。
//
// **按真类型写**,不用 `as never` 绕过去 —— 第一版就是那么写的,于是漏了 `tokenRef`,
// 而 `toSnapshotRows` 拿它去算 platform,运行期才炸。强转就是这么吃掉真错误的。
const fakeBalances = (rows: Balance[]) =>
  Layer.succeed(BalanceSource, {
    fetch: () =>
      Effect.succeed({
        status: "ok" as const,
        balances: rows,
        totalUsd: rows.reduce((sum, b) => sum + b.value, 0),
      }),
  });

const USDC_ETH = "evm:1/contract:0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48";

describe("syncServicesLayer 的接线", () => {
  it("同步一个账户 → 快照落库,总额与身份都对", async () => {
    const account = await dbFor(USER).accounts.create({
      connectorId: "evm",
      label: "W",
      creds: null,
    });

    const result = await runRequest(
      USER,
      Account.syncAccount(USER, account, null).pipe(
        Effect.provide(
          fakeBalances([
            { symbol: "USDC", amount: 2, value: 50, kind: "spot", tokenRef: USDC_ETH },
          ]),
        ),
        Effect.provide(syncServicesLayer),
      ),
    );

    expect(result.ok).toBe(true);
    const rows = await dbFor(USER).snapshots.listByAccount(account.id);
    expect(rows).toHaveLength(1);
    expect(rows[0].totalUsd).toBe(50);
    // 认币经真参考层跑过了:快照行带上了身份(认不认得出上游是另一回事,这里只要有 token_id)。
    const balances = await dbFor(USER).snapshots.balancesFor([rows[0].id]);
    expect(balances[0].tokenId).toBeTruthy();
  });

  // 折叠开关(#461)是**这一层**接上去的:`SnapshotStore.write` 默认追加,同步这条路显式开。
  // 这条钉的就是那一行有没有传 —— 折叠算得对不对由 packages/db 的 `snapshot-hour-collapse` 那组管。
  //
  // 时钟必须钉死:`syncAccount` 取的是 `Date.now()`(不走 Effect 的 Clock),赌墙钟的话两次同步
  // 恰好跨过整点就会红一次(CODING.md「别断言墙上时钟」)。
  it("同一钟点内同步两次 → 只留最后一份快照", async () => {
    const account = await dbFor(USER).accounts.create({
      connectorId: "evm",
      label: "W",
      creds: null,
    });
    const hour = Math.floor(1_800_000_000_000 / 3_600_000) * 3_600_000;
    const now = vi.spyOn(Date, "now");

    const sync = (at: number, value: number) => {
      now.mockReturnValue(at);
      return runRequest(
        USER,
        Account.syncAccount(USER, account, null).pipe(
          Effect.provide(
            fakeBalances([{ symbol: "USDC", amount: 2, value, kind: "spot", tokenRef: USDC_ETH }]),
          ),
          Effect.provide(syncServicesLayer),
        ),
      );
    };

    await sync(hour + 5 * 60_000, 50);
    await sync(hour + 35 * 60_000, 80);

    const rows = await dbFor(USER).snapshots.listByAccount(account.id);
    expect(rows).toHaveLength(1);
    expect(rows[0].totalUsd).toBe(80);
  });

  // **db 的失败必须是类型化的 `SyncDepError`,不能是 defect。**
  //
  // db store 的错误通道是 `never`(ADR:D1 挂了走 defect),而编排的隔离全靠类型化失败:
  // `Sweep.userTally` 的 `catchAll` 与 `account.ts` 的 `bestEffort` 都只接那一种。少了这道翻译,
  // 一个用户的 D1 抖动会以 defect 掀掉整轮 cron —— #375 兜的正是这件事。
  //
  // 这条以前由包里那层 deps→服务的翻译保证(`tryPromise({ catch: depError })`);那层拆掉之后归这一层。
  it("db 挂了 → 类型化失败,不是 defect(cron 才隔离得住)", async () => {
    const exit = await runRequest(
      USER,
      Effect.flatMap(SyncAccountStore, (s) => s.list()).pipe(
        Effect.provide(syncServicesLayer),
        // 打一个会 die 的 db store 进去(真 D1 挂不了,所以直接换掉那一层)。
        Effect.provide(
          Layer.succeed(DbAccountStore, {
            list: () => Effect.die(new Error("d1 down")),
          } as never),
        ),
        Effect.exit,
      ),
    );
    expect(Exit.isFailure(exit)).toBe(true);
    // 关键是**失败**而不是**defect**:`catchAll` 接得住的那一种。
    const failure = Exit.isFailure(exit) ? Cause.failureOption(exit.cause) : Option.none();
    expect(Option.isSome(failure)).toBe(true);
    expect((Option.getOrThrow(failure) as { _tag: string })._tag).toBe("SyncDepError");
  });

  // 归档账户不产生新快照;manual 不是同步源(ADR 0018)。两条都由这一层的 `list()` 过滤,
  // 编排根本见不到它们 —— 这是**接线**的责任,不是编排的。
  it("`list()` 只交出活跃的可同步账户", async () => {
    const live = await dbFor(USER).accounts.create({ connectorId: "evm", label: "L", creds: null });
    const archived = await dbFor(USER).accounts.create({
      connectorId: "evm",
      label: "A",
      creds: null,
    });
    await dbFor(USER).accounts.setArchived(archived.id, true);
    await dbFor(USER).accounts.create({ connectorId: "manual", label: "M", creds: null });

    const listed = await runRequest(
      USER,
      Effect.flatMap(SyncAccountStore, (s) => s.list()).pipe(Effect.provide(syncServicesLayer)),
    );

    expect(listed.map((a) => a.id)).toEqual([live.id]);
  });
});
