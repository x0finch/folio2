import { Effect } from "effect";
import { beforeEach, describe, expect, it } from "vitest";
import { runForUser } from "@/lib/server/runtime";
import { handleSyncAccount, SyncAccountInput } from "@/lib/server/sync/run";
import { db } from "../_kit/db";
import { blockOutbound } from "../_kit/outbound";
import { seedManualAccount } from "../_kit/seed";
import { freshUser, otherUser } from "../_kit/user";

// #527 · syncAccount
//
// **这是全仓唯一显式收 userId 的 handler**(同步内核要它标日志),所以它不走 `runEffect`,
// 也不能用 kit 里的 `call` —— 那个把 userId 吃在装配点。这里直接用同一个内核 `runForUser`,
// 与 `sync/index.ts` 的装配逐字一致。
const USER = "h-sync-run";

const run = <A, E, R>(userId: string, effect: Effect.Effect<A, E, R>) =>
  // biome-ignore lint/suspicious/noExplicitAny: 与生产装配点同形,handler 的 R 由内核补齐
  runForUser(userId, effect as any) as Promise<A>;

const exitOf = <A, E, R>(userId: string, effect: Effect.Effect<A, E, R>) =>
  run(userId, Effect.exit(effect));

beforeEach(async () => {
  blockOutbound();
  await freshUser(USER);
  await freshUser(otherUser(USER));
});

describe("syncAccount", () => {
  it("手记账户 → 直接跳过,标成 skipped,一发外呼都不发", async () => {
    const outbound = blockOutbound();
    const acc = await seedManualAccount(USER, "手记", {
      symbol: "BTC",
      unitPrice: 1,
      amount: 1,
    });

    const out = await run(USER, handleSyncAccount(USER, { accountId: acc.id }));

    expect(out).toEqual({ accountId: acc.id, ok: false, skipped: true });
    expect(outbound.calls).toEqual([]);
  });

  it("账户不存在 → NotFound,不发请求", async () => {
    const outbound = blockOutbound();

    const exit = await exitOf(USER, handleSyncAccount(USER, { accountId: "没有这个" }));

    expect(exit._tag).toBe("Failure");
    expect(outbound.calls).toEqual([]);
  });

  it("账户是别人的 → NotFound,不发请求", async () => {
    const outbound = blockOutbound();
    const theirs = await seedManualAccount(otherUser(USER), "他们的", {
      symbol: "BTC",
      unitPrice: 1,
      amount: 1,
    });

    const exit = await exitOf(USER, handleSyncAccount(USER, { accountId: theirs.id }));

    expect(exit._tag).toBe("Failure");
    expect(outbound.calls).toEqual([]);
  });

  it("凭据不齐的 CEX 账户 → 返回 skipped,与手记账户同一个形状", async () => {
    // **实测发现的一处语义合并,已列入待定(#527)。** 我原以为凭据不齐会是一个明确的失败。
    // 实际返回的是 `{ ok: false, skipped: true }` —— 和手记账户一模一样。
    //
    // 于是调用方分不出这两件事:「这个账户没有上游可同步」(手记,永远如此,不必管)
    // 和「你还没把凭据填完」(可修,而且该提示)。界面上都只能显示成「跳过了」。
    const acc = await db(USER).accounts.create({
      connectorId: "binance",
      label: "币安",
      creds: JSON.stringify({ apiKey: "只有一半" }),
    });

    const out = await run(USER, handleSyncAccount(USER, { accountId: acc.id }));

    expect(out).toEqual({ accountId: acc.id, ok: false, skipped: true });
  });

  it("凭据不齐也照样把参考层预热了 —— 四发上游请求,换来一次 skipped", async () => {
    // **实测:** 这一趟打了 `exchange_rates` ×2 与 `coins/markets` ×2,然后才决定跳过。
    // 参考层的预热发生在「要不要同步」这个判断**之前**。
    //
    // 为什么值得记:CoinGecko 免费档是每分钟 10 发,这一趟白烧 4 发。用户在设置页反复点
    // 「同步」(而那个账户正缺凭据)就能把限额打空,而屏幕上什么都没发生。
    const outbound = blockOutbound();
    const acc = await db(USER).accounts.create({
      connectorId: "binance",
      label: "币安",
      creds: JSON.stringify({ apiKey: "只有一半" }),
    });

    await run(USER, handleSyncAccount(USER, { accountId: acc.id }));

    expect(outbound.calls.length).toBeGreaterThan(0);
    expect(outbound.calls.some((u) => u.includes("exchange_rates"))).toBe(true);
  });

  it("accountId 空串 → schema 拒", () => {
    expect(SyncAccountInput.safeParse({ accountId: "" }).success).toBe(false);
  });

  // —— 下面这几条要一个「假上游」,不是一个假 fetch ——
  //
  // 清单里最值钱的那两条(**上游返回空余额列表 = 真清仓,该落一张空快照** / **上游超时 = 失败,
  // 旧快照必须保留**)需要按某个具体 connector 的报文格式伪造一整趟响应:签名头、分页、
  // 各钱包端点。那不是「打桩一发 fetch」,是把一个交易所实现一遍 —— 而且换个 connector 就得再来一遍。
  //
  // 这两条真正的归处有两个,都已经存在:
  //   · **各 connector 包自己的 parse 测试**(`packages/connectors/entry/tests/connectors/**`)
  //     用录制的 fixture 跑「上游这么说 → 余额该是什么」,包括空列表;
  //   · **`apps/web/e2e/sync-round.spec.ts`** 跑真浏览器 + 真 Worker 的一整趟同步。
  //
  // 在这一层补一个手搓的假交易所,只会得到一个「我以为上游长这样」的测试 —— 它绿着,而真实的
  // 报文变了它不会红。所以挂起,并写清去处。
  it.skip("上游返回空余额列表(真清仓)→ 落一张空快照,总额如实归零", () => {});
  it.skip("上游超时 / 报错 → 旧快照保留,不落任何东西", () => {});
  it.skip("上游 401(key 被撤了)→ 错误能让用户看懂是凭据问题", () => {});
  it.skip("同一账户两个同步同时进来 → 不落两张同一时刻的快照", () => {});
  it.skip("上游返回一个从没见过的币 → 该建的映射建上,不整趟失败", () => {});
});
