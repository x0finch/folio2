import type { TokenPriceStore, TokenPriceWrite, TokenRecordPrice } from "@folio/oracle-basic";
import { formatTokenRef } from "@folio/oracle-ref";
import { and, eq, inArray } from "drizzle-orm";
import { batchWrite, chunk } from "./cache-util";
import { type DbEnv, getDb } from "./client";
import { tokenDailyPrices, tokenRefs, tokens } from "./schema";

// `TokenPriceStore` 的 D1 实现(#199)。**一个端口跨两种作用域**,这是刻意的:
//
//   · 价 facet(当前价 / 24h / 排名)在 `tokens` 行上 → per-user,跟着代币行走
//   · 历史日价在 `token_daily_prices` → **全局**,按 tokenRef 存
//
// 端口两边都收 `tokenId`,所以调用方看不出这个区别。历史那半在这里把 tokenId 翻成
// 「该 Token 在当前上游那里叫什么」再读写:BTC 的日价是世界的事实,不该每个用户各存一份,
// 更不该丢掉「是谁给的价」(换源后曲线会前后半段来自两家)。理由全文见 #199 / schema.ts。
//
// 没有上游叫法的 Token(还没认出来的)在历史表里没有键 → 读返回空、写跳过。反正它也取不到价。

export interface UserTokenPriceStoreOpts {
  userId: string;
  namer: string; // 当前上游自报的 id;历史日价的键就是 <namer>/<localName>
  now?: () => number;
}

export function createUserTokenPriceStore(
  env: DbEnv,
  opts: UserTokenPriceStoreOpts,
): TokenPriceStore {
  const db = getDb(env);
  const { userId, namer } = opts;
  const now = opts.now ?? (() => Date.now());

  // tokenId → 它在当前上游那里的 tokenRef(历史日价的键)。没有那一档的 ref 行 → undefined。
  async function upstreamRefOf(tokenId: string): Promise<string | undefined> {
    const rows = await db
      .select({ localName: tokenRefs.localName })
      .from(tokenRefs)
      .where(
        and(
          eq(tokenRefs.userId, userId),
          eq(tokenRefs.namer, namer),
          eq(tokenRefs.tokenId, tokenId),
        ),
      );
    const localName = rows[0]?.localName;
    return localName === undefined ? undefined : formatTokenRef({ namer, localName });
  }

  return {
    // 过期不删,读出带 stale(SWR)。
    async getByIds(ids) {
      const out = new Map<string, TokenRecordPrice>();
      if (ids.length === 0) return out;
      const t = now();
      for (const part of chunk([...new Set(ids)])) {
        if (part.length === 0) continue;
        const rows = await db
          .select({
            id: tokens.id,
            unitPrice: tokens.unitPrice,
            change24h: tokens.change24h,
            marketCapRank: tokens.marketCapRank,
            priceAsOf: tokens.priceAsOf,
            priceExpiresAt: tokens.priceExpiresAt,
          })
          .from(tokens)
          .where(and(eq(tokens.userId, userId), inArray(tokens.id, part)));
        for (const r of rows) {
          if (r.unitPrice == null || r.priceAsOf == null) continue; // 尚无价
          out.set(r.id, {
            unitPrice: r.unitPrice,
            change24h: r.change24h ?? undefined,
            marketCapRank: r.marketCapRank ?? undefined,
            asOf: r.priceAsOf,
            stale: (r.priceExpiresAt ?? 0) <= t,
          });
        }
      }
      return out;
    },

    async put(prices: readonly TokenPriceWrite[], ttlMs) {
      if (prices.length === 0) return;
      const priceExpiresAt = now() + ttlMs;
      await batchWrite(
        db,
        prices.map((p) =>
          db
            .update(tokens)
            .set({
              unitPrice: p.unitPrice,
              change24h: p.change24h ?? null,
              // 排名只在有值时写。喂刷价的 simple/price 端点不含排名,`?? null` 会把持仓币
              // (反复刷价)的排名反复抹掉 —— 只剩没被刷价的币有排名。
              ...(p.marketCapRank !== undefined ? { marketCapRank: p.marketCapRank } : {}),
              priceAsOf: p.asOf,
              priceExpiresAt,
            })
            .where(and(eq(tokens.userId, userId), eq(tokens.id, p.tokenId))),
        ),
      );
    },

    // 历史日价:过去某 UTC 日的价不可变 → 永久存,无 TTL。
    async getDaily(tokenId, dayBuckets) {
      const out = new Map<number, number>();
      if (dayBuckets.length === 0) return out;
      const ref = await upstreamRefOf(tokenId);
      if (!ref) return out;
      // 固定 1 个绑定(token_ref)+ 每块 ≤90 个日桶,稳在 D1 ~100 参数上限内。
      for (const part of chunk([...new Set(dayBuckets)])) {
        if (part.length === 0) continue;
        const rows = await db
          .select({ dayBucket: tokenDailyPrices.dayBucket, unitPrice: tokenDailyPrices.unitPrice })
          .from(tokenDailyPrices)
          .where(
            and(eq(tokenDailyPrices.tokenRef, ref), inArray(tokenDailyPrices.dayBucket, part)),
          );
        for (const r of rows) out.set(r.dayBucket, r.unitPrice);
      }
      return out;
    },

    async putDaily(tokenId, prices) {
      if (prices.length === 0) return;
      const ref = await upstreamRefOf(tokenId);
      if (!ref) return; // 还没认出来的币没有全局键可落
      await writeDaily(ref, prices);
    },

    // 按 ref 直读/直写(法币历史汇率,ADR 0026):跳过 tokenId→ref 翻译。法币 ref
    // (`fiat/issued:CODE`)与 BTC 反算腿(`coingecko/issued:bitcoin`)在 per-user `token_refs`
    // 里未必有行 → 必须按 ref 直接落这张全局表。ref 就是主键的一列,无 user 参与。
    async getDailyByRef(ref, dayBuckets) {
      const out = new Map<number, number>();
      if (dayBuckets.length === 0) return out;
      for (const part of chunk([...new Set(dayBuckets)])) {
        if (part.length === 0) continue;
        const rows = await db
          .select({ dayBucket: tokenDailyPrices.dayBucket, unitPrice: tokenDailyPrices.unitPrice })
          .from(tokenDailyPrices)
          .where(
            and(eq(tokenDailyPrices.tokenRef, ref), inArray(tokenDailyPrices.dayBucket, part)),
          );
        for (const r of rows) out.set(r.dayBucket, r.unitPrice);
      }
      return out;
    },

    async putDailyByRef(ref, prices) {
      if (prices.length === 0) return;
      await writeDaily(ref, prices);
    },
  };

  // getDaily/putDailyByRef 共用的写:upsert(撞主键改价)。ref 由调用方给(翻译过 / 直给)。
  async function writeDaily(
    ref: string,
    prices: readonly { dayBucket: number; unitPrice: number }[],
  ): Promise<void> {
    await batchWrite(
      db,
      prices.map((p) =>
        db
          .insert(tokenDailyPrices)
          .values({ tokenRef: ref, dayBucket: p.dayBucket, unitPrice: p.unitPrice })
          .onConflictDoUpdate({
            target: [tokenDailyPrices.tokenRef, tokenDailyPrices.dayBucket],
            set: { unitPrice: p.unitPrice },
          }),
      ),
    );
  }
}
