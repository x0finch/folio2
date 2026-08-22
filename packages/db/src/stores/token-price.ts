import type { TokenPriceWrite, TokenRecordPrice } from "@folio/oracle-basic";
import { TokenPriceStore } from "@folio/oracle-basic/ports";
import { formatTokenRef } from "@folio/oracle-ref";
import { and, eq, inArray } from "drizzle-orm";
import { Clock, Effect, Layer, Option } from "effect";
import { tokenDailyPrices, tokenRefs, tokens } from "../schema";
import { chunk, DbClient } from "./service";

// `TokenPriceStore` 的 D1 实现(ADR 0021/0023,#199)。**每个用户一份** —— userId 由 layer 吃掉。
//
// 两半:**现价**在代币行自己那几列上(per-user,过期不删、读出带 stale);**历史日价**在
// `token_daily_prices`(全局键 = tokenRef,过去日不可变 → 永久存、无 TTL,#199/ADR 0022 的受控例外)。
//
// **时间走 `Clock`**(以前是 `opts.now`);`env` 不再出现在签名里(见 ./service.ts)。

export interface UserTokenPriceStoreOpts {
  userId: string;
  namer: string; // 当前上游的 id —— 历史日价的全局键要用它拼整条 tokenRef
}

const make = ({ userId, namer }: UserTokenPriceStoreOpts) =>
  Effect.gen(function* () {
    const database = yield* DbClient;

    // tokenId → 它在当前上游那里的 tokenRef(历史日价的键)。没有那一档的 ref 行 → `none`。
    const upstreamRefOf = (tokenId: string): Effect.Effect<Option.Option<string>> =>
      Effect.map(
        database.query((db) =>
          db
            .select({ localName: tokenRefs.localName })
            .from(tokenRefs)
            .where(
              and(
                eq(tokenRefs.userId, userId),
                eq(tokenRefs.namer, namer),
                eq(tokenRefs.tokenId, tokenId),
              ),
            ),
        ),
        (rows) =>
          Option.map(Option.fromNullable(rows[0]?.localName), (localName) =>
            formatTokenRef({ namer, localName }),
          ),
      );

    // 按 ref 读一批日桶。**`getDaily` 与 `getDailyByRef` 共用它** —— 迁移前那两个方法的方法体
    // 逐行相同(只差前面那一步 tokenId→ref 的翻译),那是抄的,不是两件事。
    const dailyByRef = (
      ref: string,
      dayBuckets: readonly number[],
    ): Effect.Effect<Map<number, number>> =>
      Effect.gen(function* () {
        const out = new Map<number, number>();
        if (dayBuckets.length === 0) return out;
        // 固定 1 个绑定(token_ref)+ 每块 ≤90 个日桶,稳在 D1 ~100 参数上限内。
        const parts = chunk([...new Set(dayBuckets)]).filter((p) => p.length > 0);
        const batches = yield* Effect.forEach(parts, (part) =>
          database.query((db) =>
            db
              .select({
                dayBucket: tokenDailyPrices.dayBucket,
                unitPrice: tokenDailyPrices.unitPrice,
              })
              .from(tokenDailyPrices)
              .where(
                and(eq(tokenDailyPrices.tokenRef, ref), inArray(tokenDailyPrices.dayBucket, part)),
              ),
          ),
        );
        for (const rows of batches) for (const r of rows) out.set(r.dayBucket, r.unitPrice);
        return out;
      });

    // 按 ref 写一批日桶:upsert(撞主键改价)。同样是两个 put 共用的那一份。
    const writeDaily = (
      ref: string,
      prices: readonly { dayBucket: number; unitPrice: number }[],
    ): Effect.Effect<void> =>
      database.batch((db) =>
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

    const store: TokenPriceStore = {
      // 过期不删,读出带 stale(SWR)。
      getByIds: (ids) =>
        Effect.gen(function* () {
          const out = new Map<string, TokenRecordPrice>();
          if (ids.length === 0) return out;
          const t = yield* Clock.currentTimeMillis;
          const parts = chunk([...new Set(ids)]).filter((p) => p.length > 0);
          const batches = yield* Effect.forEach(parts, (part) =>
            database.query((db) =>
              db
                .select({
                  id: tokens.id,
                  unitPrice: tokens.unitPrice,
                  change24h: tokens.change24h,
                  marketCapRank: tokens.marketCapRank,
                  priceAsOf: tokens.priceAsOf,
                  priceExpiresAt: tokens.priceExpiresAt,
                })
                .from(tokens)
                .where(and(eq(tokens.userId, userId), inArray(tokens.id, part))),
            ),
          );
          for (const rows of batches) {
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
        }),

      put: (prices: readonly TokenPriceWrite[], ttlMs) =>
        Effect.gen(function* () {
          if (prices.length === 0) return;
          const priceExpiresAt = (yield* Clock.currentTimeMillis) + ttlMs;
          yield* database.batch((db) =>
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
        }),

      // 历史日价:过去某 UTC 日的价不可变 → 永久存,无 TTL。
      getDaily: (tokenId, dayBuckets) =>
        Effect.gen(function* () {
          if (dayBuckets.length === 0) return new Map<number, number>();
          const ref = yield* upstreamRefOf(tokenId);
          // 还没认出来的币没有全局键可查 —— 空,不是错。
          return Option.isNone(ref)
            ? new Map<number, number>()
            : yield* dailyByRef(ref.value, dayBuckets);
        }),

      putDaily: (tokenId, prices) =>
        Effect.gen(function* () {
          if (prices.length === 0) return;
          const ref = yield* upstreamRefOf(tokenId);
          if (Option.isNone(ref)) return; // 还没认出来的币没有全局键可落
          yield* writeDaily(ref.value, prices);
        }),

      // 按 ref 直读/直写(法币历史汇率,ADR 0026):跳过 tokenId→ref 翻译。法币 ref
      // (`fiat/issued:CODE`)与 BTC 反算腿(`coingecko/issued:bitcoin`)在 per-user `token_refs`
      // 里未必有行 → 必须按 ref 直接落这张全局表。ref 就是主键的一列,无 user 参与。
      getDailyByRef: dailyByRef,

      putDailyByRef: (ref, prices) => (prices.length === 0 ? Effect.void : writeDaily(ref, prices)),
    };

    return store;
  });

export const userTokenPriceStoreLayer = (
  opts: UserTokenPriceStoreOpts,
): Layer.Layer<TokenPriceStore, never, DbClient> => Layer.effect(TokenPriceStore, make(opts));
