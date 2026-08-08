import { env } from "cloudflare:test";
import type { Balance } from "@folio/connectors-basic";
import { AccountStore as DbAccountStore } from "@folio/db";
import { Account, BalanceSource, AccountStore as SyncAccountStore } from "@folio/sync";
import { Cause, Effect, Exit, Layer, Option } from "effect";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { runRequest } from "../../src/lib/server/internal/oracle";
import { syncServicesLayer } from "../../src/lib/server/internal/sync-deps";
import { dbFor } from "./db-effect";

// `syncServicesLayer` —— app 侧对 `@folio/sync` 那四个能力的接线(#403 片 2)。
//
// 为什么单独有这个文件:`sync-mint.test.ts` 走的是包里那条 **Promise** 出口
// (`syncAccount(deps, …)` + `buildSyncDeps()`),它一行都碰不到这一层。而这一层正是这一片新加的
// 东西 —— 四个 Tag 的接线、seed 收集器的共享、估值模式的惰性读、错误往 `SyncDepError` 的归类。
// 没有它,新机器就是零覆盖上线。
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

  // **db 的失败必须是类型化的 `SyncDepError`,不能是 defect。**
  //
  // db / 参考层的错误通道都是 `never`(ADR:D1 挂了走 defect),而编排的三层隔离
  // (`bestEffort` 降级、逐账户 `catchAll`、逐用户 `catchAll`)都只接类型化失败。以前这道翻译
  // 是免费的 —— 每个 dep 都经一次 `runPromise` 边界。边界拿掉之后它得显式补上,不补的话一次
  // mint 的 D1 抖动会穿过三层隔离变成 500,而且是静默的。
  it("db 挂了 → 类型化失败,不是 defect(隔离才接得住)", async () => {
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
