import { Effect } from "effect";
import { beforeEach, describe, expect, it } from "vitest";
import { runForUser } from "@/lib/server/runtime";
import { handleSyncAccount, SyncAccountInput } from "@/lib/server/sync/run";
import { db } from "../_kit/db";
import { blockOutbound } from "../_kit/outbound";
import { seedManualAccount } from "../_kit/seed";
import { freshUser, otherUser } from "../_kit/user";

// 合并进 sync/index.test.ts 跑(#527 后续件 2):每个 vitest 文件要在 workerd 里
// 重新评估整张 import 图(实测 ~9s/文件),按目录合并把这笔钱只付一次。
describe("sync/run", () => {
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

    it("凭据不齐 → 一发上游都不打(#527 发现 3,已修:只有真同步成功才预热)", async () => {
      // 原来 skipped 之后照样跑 warmTokens,白烧 4 发(exchange_rates ×2 + coins/markets ×2)。
      // 没写新快照就没有可预热的东西 —— 现在 warm 只跟在 ok 之后。
      const outbound = blockOutbound();
      const acc = await db(USER).accounts.create({
        connectorId: "binance",
        label: "币安",
        creds: JSON.stringify({ apiKey: "只有一半" }),
      });

      await run(USER, handleSyncAccount(USER, { accountId: acc.id }));

      expect(outbound.calls).toEqual([]);
    });

    it("accountId 空串 → schema 拒", () => {
      expect(SyncAccountInput.safeParse({ accountId: "" }).success).toBe(false);
    });

    // —— 这几条的家在 sync 内核(`packages/sync/tests/orchestrator.test.ts`)——
    //
    // 那边本来就有假 provider 的接缝(`FetchOutcome` 注入),不需要伪造任何交易所报文:
    //   · **真清仓 → 写空快照**:「上游返回空余额列表 → 照样写一张空快照」(#527 后续件 6 补上)
    //   · **失败 → 保旧快照**:「重试用尽 → ok:false,不写快照」(一直就有)
    //   · **401 → 不重试、类型化失败**:「不可重试错误(AUTH_FAILED)不重试」(一直就有)
    //
    // 剩下真没人测的两条留在这儿:
    it.skip("同一账户两个同步同时进来 → 不落两张同一时刻的快照", () => {});
    it.skip("上游返回一个从没见过的币 → 该建的映射建上,不整趟失败", () => {});
  });
});
