import {
  type CoinId,
  refKey,
  type TokenCandidate,
  type TokenInfo,
  type TokenPrice,
  type TokenRef,
  type TokenStore,
} from "@folio/tokens";
import { and, asc, eq, gt, inArray, sql } from "drizzle-orm";
import { type DbEnv, getDb } from "./client";
import { tokenContract, tokenInfo, tokenMeta, tokenPrice, tokenWarm } from "./schema";

export interface TokenStoreOpts {
  source: TokenRef["source"]; // store 绑定的源(如 "coingecko");解析向读写按它分桶
  now?: () => number; // 注入便于测 TTL;默认 Date.now
}

// D1 上限 ~100 绑定参数;inArray 列表分块取(沿用 listBalancesForSnapshots 的约束)。
const IN_CHUNK = 90;
function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

// 全局代币参考缓存的 D1 实现(无 userId;按 source 分桶)。只经此工厂访问,不外泄 db/schema。
export function createTokenStore(env: DbEnv, opts: TokenStoreOpts): TokenStore {
  const db = getDb(env);
  type Batch = Parameters<typeof db.batch>[0]; // [Stmt, ...Stmt[]];Stmt = drizzle BatchItem
  type Stmt = Batch[number];
  const source = opts.source;
  const now = opts.now ?? (() => Date.now());
  const mk = (coinId: string): TokenRef => ({ source, coinId: coinId as CoinId });
  const warmKey = `warm_as_of:${source}`;

  return {
    async getCandidates(symbol: string): Promise<TokenCandidate[]> {
      // `symbol` 视为已归一(口径由调用方 @folio/tokens 保证);store 只按 key 点查,不做业务归一。
      const rows = await db
        .select()
        .from(tokenWarm)
        .where(
          and(
            eq(tokenWarm.symbol, symbol),
            eq(tokenWarm.source, source),
            gt(tokenWarm.expiresAt, now()),
          ),
        );
      return rows.map((r) => ({ ref: mk(r.coinId), marketCapRank: r.marketCapRank ?? undefined }));
    },

    async putWarm(rows, ttlMs) {
      if (rows.length === 0) return;
      const expiresAt = now() + ttlMs;
      const stmts: Stmt[] = [];
      for (const { info, price } of rows) {
        stmts.push(
          db
            .insert(tokenWarm)
            .values({
              symbol: info.symbol,
              source: info.ref.source,
              coinId: info.ref.coinId,
              marketCapRank: price.marketCapRank ?? null,
              expiresAt,
            })
            .onConflictDoUpdate({
              target: [tokenWarm.symbol, tokenWarm.source, tokenWarm.coinId],
              set: { marketCapRank: price.marketCapRank ?? null, expiresAt },
            }),
          infoUpsert(db, info, expiresAt),
          priceUpsert(db, price, expiresAt),
        );
      }
      stmts.push(
        db
          .insert(tokenMeta)
          .values({ k: warmKey, v: now() })
          .onConflictDoUpdate({ target: tokenMeta.k, set: { v: now() } }),
      );
      const [first, ...rest] = stmts;
      await db.batch([first, ...rest]);
    },

    async warmAsOf(): Promise<number | null> {
      const rows = await db.select().from(tokenMeta).where(eq(tokenMeta.k, warmKey));
      return rows[0]?.v ?? null;
    },

    async listTopTokens(limit: number): Promise<TokenInfo[]> {
      // rank 在 warm、name/logo 在 info → join (source, coinId)。两表都按 TTL 过滤。
      // 排序:无 rank 者末尾(`rank is null` 先排),再按 rank 升序。
      const t = now();
      const rows = await db
        .select({
          coinId: tokenWarm.coinId,
          symbol: tokenInfo.symbol,
          name: tokenInfo.name,
          logo: tokenInfo.logo,
        })
        .from(tokenWarm)
        .innerJoin(
          tokenInfo,
          and(eq(tokenInfo.source, tokenWarm.source), eq(tokenInfo.coinId, tokenWarm.coinId)),
        )
        .where(
          and(eq(tokenWarm.source, source), gt(tokenWarm.expiresAt, t), gt(tokenInfo.expiresAt, t)),
        )
        .orderBy(sql`${tokenWarm.marketCapRank} is null`, asc(tokenWarm.marketCapRank))
        .limit(limit);
      return rows.map((r) => ({
        ref: mk(r.coinId),
        symbol: r.symbol,
        name: r.name,
        logo: r.logo ?? undefined,
      }));
    },

    async getContractRef(chain, contract) {
      // (chain, contract) 视为已归一(小写,调用方保证);store 只按 key 点查。
      const rows = await db
        .select()
        .from(tokenContract)
        .where(
          and(
            eq(tokenContract.source, source),
            eq(tokenContract.chain, chain),
            eq(tokenContract.contract, contract),
            gt(tokenContract.expiresAt, now()),
          ),
        );
      if (rows.length === 0) return undefined; // 未知(或过期)→ 去取
      const coinId = rows[0].coinId;
      return coinId === null ? null : mk(coinId); // null = 已知缺失
    },

    async putContractRef(chain, contract, ref, ttlMs) {
      const expiresAt = now() + ttlMs;
      const row = {
        source,
        chain,
        contract,
        coinId: ref?.coinId ?? null,
        expiresAt,
      };
      await db
        .insert(tokenContract)
        .values(row)
        .onConflictDoUpdate({
          target: [tokenContract.source, tokenContract.chain, tokenContract.contract],
          set: { coinId: row.coinId, expiresAt },
        });
    },

    async getInfo(refs) {
      const out = new Map<string, TokenInfo>();
      const coinIds = refs.filter((r) => r.source === source).map((r) => r.coinId);
      for (const ids of chunk(coinIds, IN_CHUNK)) {
        const rows = await db
          .select()
          .from(tokenInfo)
          .where(
            and(
              eq(tokenInfo.source, source),
              inArray(tokenInfo.coinId, ids),
              gt(tokenInfo.expiresAt, now()),
            ),
          );
        for (const r of rows) {
          const ref = mk(r.coinId);
          out.set(refKey(ref), { ref, symbol: r.symbol, name: r.name, logo: r.logo ?? undefined });
        }
      }
      return out;
    },

    async putInfo(infos, ttlMs) {
      if (infos.length === 0) return;
      const expiresAt = now() + ttlMs;
      const [first, ...rest] = infos.map((i) => infoUpsert(db, i, expiresAt));
      await db.batch([first, ...rest]);
    },

    async getPrices(refs) {
      const out = new Map<string, TokenPrice>();
      const coinIds = refs.filter((r) => r.source === source).map((r) => r.coinId);
      for (const ids of chunk(coinIds, IN_CHUNK)) {
        const rows = await db
          .select()
          .from(tokenPrice)
          .where(
            and(
              eq(tokenPrice.source, source),
              inArray(tokenPrice.coinId, ids),
              gt(tokenPrice.expiresAt, now()),
            ),
          );
        for (const r of rows) {
          const ref = mk(r.coinId);
          out.set(refKey(ref), {
            ref,
            unitPrice: r.unitPrice,
            change24h: r.change24h ?? undefined,
            marketCapRank: r.marketCapRank ?? undefined,
            asOf: r.asOf,
          });
        }
      }
      return out;
    },

    async putPrices(prices, ttlMs) {
      if (prices.length === 0) return;
      const expiresAt = now() + ttlMs;
      const [first, ...rest] = prices.map((p) => priceUpsert(db, p, expiresAt));
      await db.batch([first, ...rest]);
    },
  };
}

function infoUpsert(db: ReturnType<typeof getDb>, i: TokenInfo, expiresAt: number) {
  return db
    .insert(tokenInfo)
    .values({
      source: i.ref.source,
      coinId: i.ref.coinId,
      symbol: i.symbol,
      name: i.name,
      logo: i.logo ?? null,
      expiresAt,
    })
    .onConflictDoUpdate({
      target: [tokenInfo.source, tokenInfo.coinId],
      set: { symbol: i.symbol, name: i.name, logo: i.logo ?? null, expiresAt },
    });
}

function priceUpsert(db: ReturnType<typeof getDb>, p: TokenPrice, expiresAt: number) {
  return db
    .insert(tokenPrice)
    .values({
      source: p.ref.source,
      coinId: p.ref.coinId,
      unitPrice: p.unitPrice,
      change24h: p.change24h ?? null,
      marketCapRank: p.marketCapRank ?? null,
      asOf: p.asOf,
      expiresAt,
    })
    .onConflictDoUpdate({
      target: [tokenPrice.source, tokenPrice.coinId],
      set: {
        unitPrice: p.unitPrice,
        change24h: p.change24h ?? null,
        marketCapRank: p.marketCapRank ?? null,
        asOf: p.asOf,
        expiresAt,
      },
    });
}
