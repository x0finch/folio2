import { Effect, Option } from "effect";
import { beforeEach, describe, expect, it } from "vitest";
import { openSyncRound, syncAllUsers } from "@/lib/server/sync/round";
import { db } from "../_kit/db";
import { blockOutbound } from "../_kit/outbound";
import { call } from "../_kit/run";
import { freshUser } from "../_kit/user";

// cron 按**组合**分区开轮(ADR 0048)。以前它跑一个不收口的大 sweep,轮的状态还只在浏览器里,
// 于是 cron 的成果对面板永远隐形。现在它开的轮与手动轮键形状完全一致 —— 面板照样读得到。
//
// 出网被掐掉,所以每个账户都会失败;这些用例要的不是「同步成功」,而是**分区、开轮、收官**
// 这三件事的形状。

describe("sync/cron", () => {
  const USER = "h-sync-cron";

  const cex = (label: string) =>
    db(USER).accounts.create({
      connectorId: "binance",
      label,
      creds: JSON.stringify({ apiKey: "k", secret: "s" }),
    });

  const roundOf = async (portfolioId: string) => {
    const got = await db(USER).syncRounds.get(portfolioId);
    return Option.getOrNull(got);
  };

  beforeEach(async () => {
    blockOutbound();
    await freshUser(USER);
  });

  it("一个组合一轮,各只装自己那些账户", async () => {
    const def = await db(USER).portfolios.ensureDefault();
    const watch = await db(USER).portfolios.create({ name: "看单" });
    const here = await cex("默认组合里的");
    const there = await cex("看单里的");
    await db(USER).portfolios.assignAccount(there.id, watch.id);

    await Effect.runPromise(syncAllUsers([USER]));

    const mine = await roundOf(def.id);
    const other = await roundOf(watch.id);
    expect(Object.keys(mine?.accounts ?? {})).toEqual([here.id]);
    expect(Object.keys(other?.accounts ?? {})).toEqual([there.id]);
    // 发起方记在轮头上 —— 面板要能说出「这一轮是定时跑的」。
    expect(mine?.trigger).toBe("cron");
    expect(other?.trigger).toBe("cron");
  });

  it("跑完两个组合都收官,小计把两边加起来", async () => {
    await db(USER).portfolios.ensureDefault();
    const watch = await db(USER).portfolios.create({ name: "看单" });
    await cex("默认组合里的");
    const there = await cex("看单里的");
    await db(USER).portfolios.assignAccount(there.id, watch.id);

    const result = await Effect.runPromise(syncAllUsers([USER]));

    const def = await db(USER).portfolios.ensureDefault();
    expect((await roundOf(def.id))?.finishedAt).not.toBeNull();
    expect((await roundOf(watch.id))?.finishedAt).not.toBeNull();
    // 出网掐掉 → 两个账户各失败一次,一个用户。
    expect(result).toEqual({ users: 1, ok: 0, failed: 2, skipped: 0 });
  });

  // 用户正好在手动同步:开轮幂等会把那一轮原样还回来,cron 就该让开 —— 不然它会把手动那一轮
  // 的明细当成自己的账本念,还会同时有两个 worker 对着同一批账户打上游。
  it("活轮还在 → cron 不插一脚,那一轮仍是手动的", async () => {
    const def = await db(USER).portfolios.ensureDefault();
    await cex("Binance spot");
    const manualRound = await call(USER, openSyncRound({ trigger: "manual" }));
    if (manualRound.round == null) throw new Error("manual open returned no round");

    await Effect.runPromise(syncAllUsers([USER]));

    const back = await roundOf(def.id);
    expect(back?.roundId).toBe(manualRound.round.roundId);
    expect(back?.trigger).toBe("manual");
    // cron 没跑它,所以它还没收官 —— 手动那条路自己会收。
    expect(back?.finishedAt).toBeNull();
  });

  // 开了轮就必须收官,空组合也不例外 —— 否则 120s 后那个组合的面板会挂着一句「中断」,
  // 而它根本没事可做。
  it("空组合那一轮立刻收官,不会挂成中断", async () => {
    const def = await db(USER).portfolios.ensureDefault();
    await Effect.runPromise(syncAllUsers([USER]));
    const back = await roundOf(def.id);
    expect(back?.accounts).toEqual({});
    expect(back?.finishedAt).not.toBeNull();
  });
});
