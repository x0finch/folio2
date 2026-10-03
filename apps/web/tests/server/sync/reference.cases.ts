import { env } from "cloudflare:test";
import type { Balance } from "@folio/connectors-basic";
import { SUPPORTED_CURRENCIES } from "@folio/oracle-basic";
import { Effect, Option } from "effect";
import { beforeEach, describe, expect, it } from "vitest";
import { REFERENCE_JOB_UPSTREAM_CALLS } from "@/lib/server/jobs/constants";
import { consumeMessage, type JobMessage } from "@/lib/server/jobs/consume";
import type { Job } from "@/lib/server/jobs/message";
import { type Enqueued, JobQueue } from "@/lib/server/jobs/queue";
import { fanOutDaily } from "@/lib/server/jobs/schedule";
import { handleGetCurrencyPreference } from "@/lib/server/preferences/currency";
import { runEffect } from "@/lib/server/runtime";
import { revalue } from "@/lib/server/sync/revalue";
import { handleListFiatOptions } from "@/lib/server/tokens/list-fiat-options";
import { db } from "../_kit/db";
import { blockOutbound, json, stubOutbound } from "../_kit/outbound";
import { call } from "../_kit/run";
import { DAY, seedAccount, seedSnapshot } from "../_kit/seed";
import { freshUser } from "../_kit/user";

// 参考层那五件小活(FOL-88):汇率 / 平台 / 目录 / DeFi 图 / 剪 note,一件一条消息。
// 每件钉三样:**出网数不超过推导出来的预算**(按真 fetch 数,adapter 真在发请求)、**重跑零出网**
// (at-least-once 的队列上,重投必须是免费的)、以及真写进了库。
// 另钉读路径:展示币种 / 法币下拉 / 同步的重估**一发上游都不打**,缓存冷也一样。

describe("jobs/reference", () => {
  const USER = "h-jobs-reference";

  const consume = async (body: Job) => {
    const state = { acked: false, retried: false };
    const message: JobMessage = {
      id: `m-${Math.random()}`,
      body,
      attempts: 1,
      ack: () => {
        state.acked = true;
      },
      retry: () => {
        state.retried = true;
      },
    };
    await Effect.runPromise(consumeMessage(message));
    return state;
  };

  const ACKED = { acked: true, retried: false };

  // 上游那个端点以 BTC 为基准:value = 1 BTC 值多少该币种。**全部支持币种都给**(真上游就是这样):
  // `fx.warm()` 的「都新鲜才跳过」按全部支持币种判,缺一个就每次都回源 —— 仍在预算内(1 发),
  // 但那就不是「重跑零出网」了。
  const RATES = {
    rates: {
      ...Object.fromEntries(
        SUPPORTED_CURRENCIES.map((c) => [c.code.toLowerCase(), { value: 50_000, type: "fiat" }]),
      ),
      btc: { value: 1, type: "crypto" },
      usd: { value: 100000, type: "fiat" },
      eur: { value: 92000, type: "fiat" },
    },
  };
  const EUR_USD = 100000 / 92000;

  const warmFx = async () => {
    stubOutbound([["/exchange_rates", () => json(RATES)]]);
    expect(await consume({ kind: "fx", userId: USER })).toEqual(ACKED);
  };

  // 把汇率的过期戳推到过去 —— 「隔了很久没暖」。
  const expireFx = () =>
    env.DB.prepare("UPDATE user_cache SET expires_at = 1 WHERE user_id = ? AND k LIKE 'fx:%'")
      .bind(USER)
      .run();

  beforeEach(async () => {
    blockOutbound();
    await freshUser(USER);
    await db(USER).portfolios.ensureDefault();
  });

  describe("fx", () => {
    it("一发拉全部币种写进这个用户的缓存;刚暖过再跑 → 零出网", async () => {
      const first = stubOutbound([["/exchange_rates", () => json(RATES)]]);
      expect(await consume({ kind: "fx", userId: USER })).toEqual(ACKED);
      expect(first.calls).toHaveLength(1);
      expect(first.calls.length).toBeLessThanOrEqual(REFERENCE_JOB_UPSTREAM_CALLS.fx);
      const hit = await db(USER).cache.get("fx:EUR");
      expect(Option.map(hit, (e) => Number(e.value))).toEqual(Option.some(EUR_USD));

      const again = blockOutbound();
      expect(await consume({ kind: "fx", userId: USER })).toEqual(ACKED);
      expect(again.calls).toEqual([]);
    });
  });

  describe("platforms", () => {
    const CHAINS = [{ id: "arbitrum-one", name: "Arbitrum One", chain_identifier: 42161 }];

    it("最新快照里的链键缺 → 拉一次整张链表、只写这几个键;再跑 → 零出网", async () => {
      const acc = await seedAccount(USER, "w", "bitcoin");
      await seedSnapshot(USER, acc.id, Date.now(), [
        { tokenId: "tok-a", amount: 1, usdValue: 1, platform: "arbitrum-one" },
      ]);

      const first = stubOutbound([["/asset_platforms", () => json(CHAINS)]]);
      expect(await consume({ kind: "platforms", userId: USER })).toEqual(ACKED);
      expect(first.calls.length).toBeLessThanOrEqual(REFERENCE_JOB_UPSTREAM_CALLS.platforms);
      const hit = await db(USER).cache.get("platform:arbitrum-one");
      expect(Option.isSome(hit)).toBe(true);

      const again = blockOutbound();
      expect(await consume({ kind: "platforms", userId: USER })).toEqual(ACKED);
      expect(again.calls).toEqual([]);
    });

    it("没有快照 → 什么都不问", async () => {
      const outbound = blockOutbound();
      expect(await consume({ kind: "platforms", userId: USER })).toEqual(ACKED);
      expect(outbound.calls).toEqual([]);
    });
  });

  describe("catalogue", () => {
    const MARKETS = [
      { id: "bitcoin", symbol: "btc", name: "Bitcoin", current_price: 50_000, market_cap_rank: 1 },
      { id: "ethereum", symbol: "eth", name: "Ethereum", current_price: 3_000, market_cap_rank: 2 },
    ];

    it("冷 → 拉一次目录写进缓存(≤ 预算);一周 TTL 内再跑 → 零出网", async () => {
      const first = stubOutbound([["/coins/markets", () => json(MARKETS)]]);
      expect(await consume({ kind: "catalogue", userId: USER })).toEqual(ACKED);
      expect(first.calls.length).toBeLessThanOrEqual(REFERENCE_JOB_UPSTREAM_CALLS.catalogue);
      expect(Option.isSome(await db(USER).cache.get("warm"))).toBe(true);

      const again = blockOutbound();
      expect(await consume({ kind: "catalogue", userId: USER })).toEqual(ACKED);
      expect(again.calls).toEqual([]);
    });
  });

  describe("defi-logos", () => {
    it("从最新快照的 meta 收集协议图写缓存,零出网;重跑同值覆盖", async () => {
      const acc = await seedAccount(USER, "w", "bitcoin");
      await seedSnapshot(USER, acc.id, Date.now(), [
        {
          tokenId: "tok-a",
          amount: 1,
          usdValue: 1,
          kind: "defi",
          meta: { protocol: "aave", protocolLogo: "https://example.test/aave.png" },
        },
      ]);
      const outbound = blockOutbound();

      expect(await consume({ kind: "defi-logos", userId: USER })).toEqual(ACKED);
      expect(await consume({ kind: "defi-logos", userId: USER })).toEqual(ACKED);

      expect(outbound.calls).toHaveLength(REFERENCE_JOB_UPSTREAM_CALLS["defi-logos"]);
      const hit = await db(USER).cache.get("defi-logo:aave");
      expect(Option.map(hit, (e) => e.value)).toEqual(Option.some("https://example.test/aave.png"));
    });
  });

  describe("prune-notes", () => {
    const noteOf = async (snapshotId: string) =>
      (
        await env.DB.prepare("SELECT note FROM snapshots WHERE id = ?")
          .bind(snapshotId)
          .first<{ note: string | null }>()
      )?.note ?? null;

    const withNote = (accountId: string, takenAt: number) =>
      db(USER).snapshots.write(accountId, {
        takenAt,
        totalUsd: 1,
        note: [{ title: `n@${takenAt}`, content: [{ label: "n", value: 1 }] }],
        balances: [],
      });

    it("剪掉 7 天外的 note、留 7 天内的,零出网;重投剪到 0 行", async () => {
      const acc = await seedAccount(USER, "w", "bitcoin");
      const now = Date.now();
      const old = await withNote(acc.id, now - 8 * DAY);
      const recent = await withNote(acc.id, now - 6 * DAY);
      const latest = await withNote(acc.id, now);
      const outbound = blockOutbound();

      expect(await consume({ kind: "prune-notes", userId: USER })).toEqual(ACKED);
      expect(await noteOf(old)).toBeNull();
      expect(await noteOf(recent)).not.toBeNull();
      expect(await noteOf(latest)).not.toBeNull();

      // 幂等:再跑一遍什么都不变。
      expect(await consume({ kind: "prune-notes", userId: USER })).toEqual(ACKED);
      expect(await noteOf(recent)).not.toBeNull();
      expect(outbound.calls).toHaveLength(REFERENCE_JOB_UPSTREAM_CALLS["prune-notes"]);
    });
  });

  describe("每天那个 cron 的投递", () => {
    it("每个用户一条 prune-notes + 一条 catalogue,不延后;一发上游都不打", async () => {
      const outbound = blockOutbound();
      const sent: Enqueued[] = [];
      const result = await Effect.runPromise(
        fanOutDaily(["u1", "u2"]).pipe(
          Effect.provideService(JobQueue, {
            poke: Effect.void,
            send: (batch) => Effect.sync(() => void sent.push(...batch)),
          }),
        ),
      );
      expect(sent).toEqual([
        { job: { kind: "prune-notes", userId: "u1" } },
        { job: { kind: "catalogue", userId: "u1" } },
        { job: { kind: "prune-notes", userId: "u2" } },
        { job: { kind: "catalogue", userId: "u2" } },
      ]);
      expect(result).toEqual({ jobs: 4 });
      expect(outbound.calls).toEqual([]);
    });
  });

  // FOL-88 的另一半:读路径只读缓存。以前 `getCurrencyPreference` / `listFiatOptions` 冷缓存就当场
  // `fx.warm`(一个读端点打上游、写库)。
  describe("读路径不出网", () => {
    const preferenceOf = (code: string) =>
      runEffect(handleGetCurrencyPreference)({ data: { code }, context: { userId: USER } });

    it("getCurrencyPreference:缓存冷 → 回退 USD,零出网", async () => {
      const outbound = blockOutbound();
      expect(await preferenceOf("EUR")).toMatchObject({ currency: { code: "USD" }, rate: 1 });
      expect(outbound.calls).toEqual([]);
    });

    it("getCurrencyPreference:汇率过期了照用旧值,零出网", async () => {
      await warmFx();
      await expireFx();
      const outbound = blockOutbound();
      const pref = await preferenceOf("EUR");
      expect(pref.currency.code).toBe("EUR");
      expect(pref.rate).toBeCloseTo(EUR_USD, 6);
      expect(outbound.calls).toEqual([]);
    });

    it("listFiatOptions:缓存冷 → 选项照给、EUR 不带价,零出网", async () => {
      const outbound = blockOutbound();
      const out = await call(USER, handleListFiatOptions({ locale: "en" }));
      expect(out.length).toBeGreaterThan(1);
      expect((out.find((o) => o.symbol === "EUR") as { price?: number }).price).toBeUndefined();
      expect((out.find((o) => o.symbol === "USD") as { price?: number }).price).toBe(1);
      expect(outbound.calls).toEqual([]);
    });

    it("listFiatOptions:暖过之后带价,零出网", async () => {
      await warmFx();
      const outbound = blockOutbound();
      const out = await call(USER, handleListFiatOptions({ locale: "en" }));
      const eur = out.find((o) => o.symbol === "EUR") as { price?: number };
      expect(eur.price).toBeCloseTo(EUR_USD, 6);
      expect(outbound.calls).toEqual([]);
    });

    const eurCash: Balance = {
      kind: "spot",
      symbol: "EUR",
      amount: 100,
      value: 100,
      tokenRef: "fiat/issued:EUR",
    };

    it("revalue:法币汇率过期也只读缓存,零出网", async () => {
      await warmFx();
      await expireFx();
      const outbound = blockOutbound();
      const [out] = await call(USER, revalue(false, [eurCash], new Map()));
      expect(out?.value).toBeCloseTo(100 * EUR_USD, 6);
      expect(outbound.calls).toEqual([]);
    });

    it("revalue:缓存冷 → 保留 provider 原值,零出网", async () => {
      const outbound = blockOutbound();
      const [out] = await call(USER, revalue(false, [eurCash], new Map()));
      expect(out?.value).toBe(100);
      expect(outbound.calls).toEqual([]);
    });
  });
});
