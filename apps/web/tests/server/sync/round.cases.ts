import { Effect } from "effect";
import { beforeEach, describe, expect, it } from "vitest";
import { overviewKey, precomputeMarkKey, tabStripKey } from "@/lib/server/portfolio/precompute";
import {
  handleGetSyncRound,
  openSyncRound,
  precomputeAllUsers,
  ROUND_HEARTBEAT_MS,
  ROUND_RETENTION_MS,
  runSyncRound,
} from "@/lib/server/sync/round";
import { db } from "../_kit/db";
import { blockOutbound } from "../_kit/outbound";
import { call } from "../_kit/run";
import { seedSnapshot } from "../_kit/seed";
import { freshUser } from "../_kit/user";

// 开轮 / 读轮(ADR 0048)。对着真 D1 跑,因为这两件事的正确性都在「哪些账户进这一轮」与
// 「同一个键两边算得一样吗」上 —— 那两条都要真的账户行、真的组合归属。

describe("sync/round", () => {
  const USER = "h-sync-round";

  const cex = (label: string) =>
    db(USER).accounts.create({
      connectorId: "binance",
      label,
      creds: JSON.stringify({ apiKey: "k", secret: "s" }),
    });

  const manual = (label: string) =>
    db(USER).accounts.create({ connectorId: "manual", label, creds: null });

  // 断言侧把 `round` 掀成非空:这套用例造不出「行在两句之间被删」那一幕,真走到就该炸给人看。
  const open = async (portfolioId?: string) => {
    const out = await call(USER, openSyncRound({ portfolioId, trigger: "manual" }));
    if (out.round == null) throw new Error("open returned no round — the row vanished mid-test?");
    return { opened: out.opened, round: out.round };
  };

  const read = (portfolioId: string) => call(USER, handleGetSyncRound({ portfolioId }));

  beforeEach(async () => {
    blockOutbound();
    await freshUser(USER);
  });

  describe("开轮", () => {
    it("名单 = 当前组合内、活跃、非手记 —— 与页头摘要同一条判据", async () => {
      const live = await cex("Binance spot");
      const archived = await cex("旧号");
      await db(USER).accounts.setArchived(archived.id, true);
      await manual("手记");

      const { round, opened } = await open();
      expect(opened).toBe(true);
      expect(Object.keys(round.accounts)).toEqual([live.id]);
      expect(round.accounts[live.id]).toEqual({ label: "Binance spot", status: "pending" });
      expect(round.trigger).toBe("manual");
      expect(round.finishedAt).toBeNull();
    });

    it("别的组合里的账户不进这一轮", async () => {
      const here = await cex("默认组合里的");
      const there = await cex("看单里的");
      const watch = await db(USER).portfolios.create({ name: "看单" });
      await db(USER).portfolios.assignAccount(there.id, watch.id);

      const mine = await open();
      expect(Object.keys(mine.round.accounts)).toEqual([here.id]);
      const other = await open(watch.id);
      expect(Object.keys(other.round.accounts)).toEqual([there.id]);
    });

    // 第二个设备点同步 / cron 撞上手动:看到的是同一轮,不是被清空重来的一轮。
    it("活轮还在 → 第二次开轮返回同一轮", async () => {
      await cex("Binance spot");
      const first = await open();
      const second = await open();
      expect(second.opened).toBe(false);
      expect(second.round.roundId).toBe(first.round.roundId);
    });

    it("心跳 = 开轮那一刻 + 120s", async () => {
      await cex("Binance spot");
      const before = Date.now();
      const { round } = await open();
      expect(round.expiresAt).toBeGreaterThanOrEqual(before + ROUND_HEARTBEAT_MS);
      expect(ROUND_RETENTION_MS).toBeGreaterThan(ROUND_HEARTBEAT_MS);
    });
  });

  describe("读轮", () => {
    it("这个组合从没开过 → null(不是一个空轮)", async () => {
      const pf = await db(USER).portfolios.ensureDefault();
      expect(await read(pf.id)).toBeNull();
    });

    it("刚开的一轮 → 在跑,x / N 从 0 起,正在同步的是第一个", async () => {
      await cex("Binance spot");
      await cex("Kraken");
      await open();

      const pf = await db(USER).portfolios.ensureDefault();
      const view = await read(pf.id);
      expect(view?.state).toBe("running");
      expect(view?.total).toBe(2);
      expect(view?.settled).toBe(0);
      expect(view?.synced).toBe(0);
      expect(view?.failed).toEqual([]);
      expect(view?.current).toBe("Binance spot");
    });

    // 开轮对坏 id 退回默认组合(开轮必须落在一个真组合上);读轮**不解析**,直接读键 ——
    // 这是 1.5s 一发的路,省两条查询,而键本身 user-scoped,坏 id 只会读到空键。
    // 客户端传来的永远是选择器里真实存在的 id,所以两边在真实流量上落的是同一个键。
    it("开轮的坏 id 落到默认组合;读轮拿真 id 读得到,拿坏 id 读到空", async () => {
      await cex("Binance spot");
      const opened = await open("pf-never-existed");
      const def = await db(USER).portfolios.ensureDefault();
      expect(opened.round.portfolioId).toBe(def.id);
      expect((await read(def.id))?.roundId).toBe(opened.round.roundId);
      expect(await read("pf-also-nonsense")).toBeNull();
    });
  });

  // 真跑一轮(出网被掐掉,所以有凭据的那个必定失败)。测的是接线本身:结果逐条落进那一轮、
  // 三档分对、跑完收官 —— 这三件事以前分别住在流的两头,没有一处能一起看见。
  describe("跑一轮", () => {
    it("逐个账户落进这一轮,跑完收官", async () => {
      const willFail = await cex("Binance spot");
      const noKeys = await db(USER).accounts.create({
        connectorId: "binance",
        label: "还没填 key",
        creds: null,
      });

      const { round } = await open();
      await runSyncRound(USER, round);

      const pf = await db(USER).portfolios.ensureDefault();
      const view = await read(pf.id);
      expect(view?.state).toBe("done");
      expect(view?.settled).toBe(2);
      expect(view?.needsKeys).toBe(1);
      expect(view?.failed.map((f) => f.accountId)).toEqual([willFail.id]);
      // 上游的原话原样留着 —— 面板那一行不翻译它。
      expect(view?.failed[0]?.error).toBeTruthy();
      expect(view?.synced).toBe(0);
      // 逐账户的失败不是「整轮没跑起来」,那一句必须还是空的。
      expect(view?.error).toBeNull();
      expect(noKeys.id in round.accounts).toBe(true);
    });

    // FOL-35 / FOL-36 / ADR 0049:收官之后这一组合的预计算(总览 + tab 条)必须已经算好存下。
    // **24h 盈亏预计算 FOL-51 退场**:盈亏改浏览器两端相减,不再落键 —— 这里只钉剩下的两族。
    // 钉在这一层而不是别处:「算的时刻挂在同步收尾上」是接线,而接线只有整条路跑一遍才看得见。
    it("收官之后,这个组合的预计算就位", async () => {
      const acc = await cex("Binance spot");
      const now = Date.now();
      await seedSnapshot(USER, acc.id, now, [{ tokenId: "token-btc", amount: 1, usdValue: 130 }]);

      const { round } = await open();
      await runSyncRound(USER, round);

      const pf = round.portfolioId;
      const at = async (k: string) => (await db(USER).cache.get(k))._tag;
      expect(await at(overviewKey(pf, null))).toBe("Some");
      expect(await at(tabStripKey(pf, null))).toBe("Some");
    });

    // **cron 那一支刻意不在轮里预计算。**
    //
    // 预计算的「当下点」吃的是热过的价(现推的 `liveValue`),而 cron 的预热不在轮里 ——
    // 它按用户统一做,发生在整个同步阶段之后。在轮里算就是每小时拿上一小时的价算一遍,
    // 然后让它挂满 90 分钟。所以 cron 的预计算挪到了 `precomputeAllUsers`(sweep 的第三趟,
    // 排在 warm 后面)。这条钉住那次搬家:轮里**只**抬水位线,不落值。
    it("cron 那一支不在轮里预计算,只抬水位线(它的预热还没发生)", async () => {
      const acc = await cex("Binance spot");
      const now = Date.now();
      await seedSnapshot(USER, acc.id, now, [{ tokenId: "token-btc", amount: 1, usdValue: 110 }]);

      const { round } = await open();
      await runSyncRound(USER, round, { warm: false });

      expect((await db(USER).cache.get(overviewKey(round.portfolioId, null)))._tag).toBe("None");
      expect((await db(USER).cache.get(precomputeMarkKey(round.portfolioId)))._tag).toBe("Some");
    });

    // sweep 的第三趟:逐用户、逐组合把值真算出来。cron 的正确性靠「轮抬水位线 + 这一趟落值」
    // 两半合起来,所以两半都得有钉子。
    it("precomputeAllUsers 给这个用户每个组合都落下值", async () => {
      const acc = await cex("Binance spot");
      const now = Date.now();
      await seedSnapshot(USER, acc.id, now, [{ tokenId: "token-btc", amount: 1, usdValue: 130 }]);
      const watch = await db(USER).portfolios.create({ name: "看单" });
      const home = (await db(USER).portfolios.ensureDefault()).id;

      const out = await Effect.runPromise(precomputeAllUsers([USER]));

      expect(out.failed).toBe(0);
      // 总览预计算逐组合落下(盈亏 FOL-51 起不再预计算)。
      expect((await db(USER).cache.get(overviewKey(home, null)))._tag).toBe("Some");
      expect((await db(USER).cache.get(overviewKey(watch.id, null)))._tag).toBe("Some");
    });

    // 陈旧的 worker 撞上新一轮:它那几笔写落空成 no-op(条件在 db 那一层),这里钉的是
    // 「整条路真的这么表现」—— 新一轮不会被上一轮的尾巴改花。
    it("上一轮的尾巴写不进新一轮", async () => {
      await cex("Binance spot");
      const stale = await open();
      await db(USER).syncRounds.finish({
        portfolioId: stale.round.portfolioId,
        roundId: stale.round.roundId,
        retentionMs: 1_000,
      });
      const fresh = await open();
      expect(fresh.opened).toBe(true);

      await runSyncRound(USER, stale.round); // 老轮的 worker 现在才跑完

      const view = await read(fresh.round.portfolioId);
      expect(view?.roundId).toBe(fresh.round.roundId);
      expect(view?.settled).toBe(0);
      expect(view?.state).toBe("running");
    });
  });
});
