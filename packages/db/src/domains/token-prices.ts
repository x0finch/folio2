import type { TokenPriceWrite, TokenRecordPrice, TokenRef } from "@folio/oracle-basic";
import { formatTokenRef } from "@folio/oracle-ref";
import { and, eq, inArray, sql } from "drizzle-orm";
import { Clock, Effect, Option } from "effect";
import { chunk, type DbClient } from "../client";
import { tokenDailyPrices, tokenRefs, tokens } from "../schema";

// 代币的**价** facet(ADR 0021/0023,#199)。**每个用户一份** —— userId 由 layer 吃掉。
//
// **契约就是下面这段实现。** 以前它顶的是 `@folio/oracle-basic` 的 `TokenPriceStore` 接口 ——
// 那套倒置换不来第二个实现(唯一的第二实现是 oracle 测试里的内存假货,照形状写即可),
// 只换来两份会各自漂移的 doc。方法上的注释因此都搬到了实现这边。
//
// 两半:**现价**在代币行自己那几列上(per-user,过期不删、读出带 stale);**历史日价**在
// `token_daily_prices`(全局键 = tokenRef,过去日不可变 → 永久存、无 TTL,#199/ADR 0022 的受控例外)。
//
// **时间走 `Clock`**(以前是 `opts.now`);`env` 不再出现在签名里(见 ../client.ts)。

// 一条多行 INSERT 装几行日价:3 个绑定 / 行 × 30 = 90,在 D1 ~100 参数上限内。
const DAILY_ROWS_PER_STATEMENT = 30;

export const makeUserTokenPriceStore = (namer: string) => (client: DbClient, userId: string) => {
  // tokenId → 它在当前上游那里的 tokenRef(历史日价的键)。没有那一档的 ref 行 → `none`。
  const upstreamRefOf = (tokenId: string): Effect.Effect<Option.Option<string>> =>
    Effect.map(
      client.query((db) =>
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
        client.query((db) =>
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
  // **多行 INSERT**(FOL-90):补日价那条活一窗就是一年 365 行,一行一条语句的话光拼语句就要吃掉
  // 免费计划 10ms CPU 的一大块。每行 3 个绑定 → 一条语句 `DAILY_ROWS_PER_STATEMENT` 行,
  // 稳在 D1 ~100 参数上限内;几条语句一个 batch(一次往返、原子)。
  const writeDaily = (
    ref: string,
    prices: readonly { dayBucket: number; unitPrice: number }[],
  ): Effect.Effect<void> =>
    client.batch((db) =>
      chunk(prices, DAILY_ROWS_PER_STATEMENT)
        .filter((part) => part.length > 0)
        .map((part) =>
          db
            .insert(tokenDailyPrices)
            .values(
              part.map((p) => ({ tokenRef: ref, dayBucket: p.dayBucket, unitPrice: p.unitPrice })),
            )
            .onConflictDoUpdate({
              target: [tokenDailyPrices.tokenRef, tokenDailyPrices.dayBucket],
              set: { unitPrice: sql`excluded.unit_price` },
            }),
        ),
    );

  return {
    /** 本用户全部 Token 的价(`getByIds` 的整表版,FOL-92)。口径同下:尚无价的不出现、过期照给。 */
    getAll: (): Effect.Effect<Map<string, TokenRecordPrice>> =>
      Effect.gen(function* () {
        const t = yield* Clock.currentTimeMillis;
        const rows = yield* client.query((db) =>
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
            .where(eq(tokens.userId, userId)),
        );
        const out = new Map<string, TokenRecordPrice>();
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
        return out;
      }),

    // 过期不删,读出带 stale(SWR)。尚无价的行不出现在结果里。
    getByIds: (ids: readonly string[]): Effect.Effect<Map<string, TokenRecordPrice>> =>
      Effect.gen(function* () {
        const out = new Map<string, TokenRecordPrice>();
        if (ids.length === 0) return out;
        const t = yield* Clock.currentTimeMillis;
        const parts = chunk([...new Set(ids)]).filter((p) => p.length > 0);
        const batches = yield* Effect.forEach(parts, (part) =>
          client.query((db) =>
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

    put: (prices: readonly TokenPriceWrite[], ttlMs: number): Effect.Effect<void> =>
      Effect.gen(function* () {
        if (prices.length === 0) return;
        const priceExpiresAt = (yield* Clock.currentTimeMillis) + ttlMs;
        yield* client.batch((db) =>
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

    // 历史日价(时序、按范围查 → 真表):过去某 UTC 日的价不可变 → 永久存,无 TTL。
    getDaily: (
      tokenId: string,
      dayBuckets: readonly number[],
    ): Effect.Effect<Map<number, number>> =>
      Effect.gen(function* () {
        if (dayBuckets.length === 0) return new Map<number, number>();
        const ref = yield* upstreamRefOf(tokenId);
        // 还没认出来的币没有全局键可查 —— 空,不是错。
        return Option.isNone(ref)
          ? new Map<number, number>()
          : yield* dailyByRef(ref.value, dayBuckets);
      }),

    putDaily: (
      tokenId: string,
      prices: readonly { dayBucket: number; unitPrice: number }[],
    ): Effect.Effect<void> =>
      Effect.gen(function* () {
        if (prices.length === 0) return;
        const ref = yield* upstreamRefOf(tokenId);
        if (Option.isNone(ref)) return; // 还没认出来的币没有全局键可落
        yield* writeDaily(ref.value, prices);
      }),

    // 按 ref 直读/直写(法币历史汇率,ADR 0026):跳过 tokenId→ref 翻译。法币 ref
    // (`fiat/issued:CODE`)与 BTC 反算腿(`coingecko/issued:bitcoin`)在 per-user `token_refs`
    // 里未必有行 → 必须按 ref 直接落这张全局表。ref 就是主键的一列,无 user 参与。
    getDailyByRef: (
      ref: TokenRef,
      dayBuckets: readonly number[],
    ): Effect.Effect<Map<number, number>> => dailyByRef(ref, dayBuckets),

    putDailyByRef: (
      ref: TokenRef,
      prices: readonly { dayBucket: number; unitPrice: number }[],
    ): Effect.Effect<void> => (prices.length === 0 ? Effect.void : writeDaily(ref, prices)),
  };
};
