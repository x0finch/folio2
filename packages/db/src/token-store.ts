import {
  type CgkCoinId,
  type ProviderTokenSeed,
  refKey,
  type TokenCandidate,
  type TokenInfo,
  type TokenRecord,
  type TokenRef,
  type TokenStore,
} from "@folio/tokens";
import { and, asc, eq, gt, inArray, sql } from "drizzle-orm";
import { type DbEnv, getDb } from "./client";
import { tokenIndex, tokenMeta, tokens } from "./schema";

export interface TokenStoreOpts {
  source: TokenRef["source"]; // store 绑定的规范源(如 "coingecko");ref 只对该源的行成立
  now?: () => number; // 注入便于测 TTL;默认 Date.now
}

// 孤儿行(CGK 未收录,provider 采集)的 source 标记;identifier = tokenKey 键。
const PROVIDER_SOURCE = "provider";

// D1 上限 ~100 绑定参数;inArray 列表分块取(沿用 listBalancesForSnapshots 的约束)。
const IN_CHUNK = 90;
function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

type TokenRow = typeof tokens.$inferSelect;

// 代币表 + 索引表的 D1 实现(无 userId;全局参考数据)。只经此工厂访问,不外泄 db/schema。
// 并发注记:putWarm/ensureTokenKey 先查后批写,极端并发下(cron 与手动 sync 同拍)新行 id 预分配
// 可能与冲突保留的旧 id 不一致 → 索引 FK 失败、整批回滚 —— 下次 warm/sync 自愈,可接受(warm 已单飞)。
export function createTokenStore(env: DbEnv, opts: TokenStoreOpts): TokenStore {
  const db = getDb(env);
  type Batch = Parameters<typeof db.batch>[0]; // [Stmt, ...Stmt[]];Stmt = drizzle BatchItem
  type Stmt = Batch[number];
  const source = opts.source;
  const now = opts.now ?? (() => Date.now());
  const mk = (identifier: string): TokenRef => ({
    source,
    identifier: identifier as CgkCoinId,
  });
  const warmKey = `warm_as_of:${source}`;

  // 行 → 领域记录。价过期不删:读出带 stale(SWR,展示先给旧价)。
  const toRecord = (r: TokenRow): TokenRecord => ({
    id: r.id,
    ref: r.source === source ? mk(r.identifier) : null,
    symbol: r.symbol,
    name: r.name,
    logo: r.logo ?? undefined,
    providerLogo: r.providerLogo ?? undefined,
    marketCapRank: r.marketCapRank ?? undefined,
    price:
      r.unitPrice != null && r.priceAsOf != null
        ? {
            unitPrice: r.unitPrice,
            change24h: r.change24h ?? undefined,
            asOf: r.priceAsOf,
            stale: (r.priceExpiresAt ?? 0) <= now(),
          }
        : undefined,
  });

  // 预取一批 (source=本源, identifier) 的现有行 id;miss 的由调用侧预分配 UUID。
  async function existingIds(identifiers: string[]): Promise<Map<string, string>> {
    const out = new Map<string, string>();
    for (const ids of chunk(identifiers, IN_CHUNK)) {
      const rows = await db
        .select({ id: tokens.id, identifier: tokens.identifier })
        .from(tokens)
        .where(and(eq(tokens.source, source), inArray(tokens.identifier, ids)));
      for (const r of rows) out.set(r.identifier, r.id);
    }
    return out;
  }

  return {
    async getCandidates(symbol: string): Promise<TokenCandidate[]> {
      // `symbol` 视为已归一(调用方 @folio/tokens 保证);store 只按 key 点查。
      const rows = await db
        .select({ identifier: tokens.identifier, rank: tokens.marketCapRank, src: tokens.source })
        .from(tokenIndex)
        .innerJoin(tokens, eq(tokens.id, tokenIndex.tokenId))
        .where(
          and(
            eq(tokenIndex.kind, "symbol"),
            eq(tokenIndex.key, symbol),
            gt(tokenIndex.expiresAt, now()),
          ),
        );
      return rows
        .filter((r) => r.src === source)
        .map((r) => ({ ref: mk(r.identifier), marketCapRank: r.rank ?? undefined }));
    },

    async putWarm(rows, warmTtlMs, infoTtlMs) {
      if (rows.length === 0) return;
      const t = now();
      const symExpiresAt = t + warmTtlMs; // symbol 索引 + 价(短)
      const infoExpiresAt = t + infoTtlMs; // name/logo(长)
      const ids = await existingIds(rows.map((r) => r.info.ref.identifier));
      const stmts: Stmt[] = [];
      for (const { info, price } of rows) {
        const id = ids.get(info.ref.identifier) ?? crypto.randomUUID();
        stmts.push(
          db
            .insert(tokens)
            .values({
              id,
              source: info.ref.source,
              identifier: info.ref.identifier,
              symbol: info.symbol,
              name: info.name,
              logo: info.logo ?? null,
              marketCapRank: price.marketCapRank ?? null,
              infoExpiresAt,
              unitPrice: price.unitPrice,
              change24h: price.change24h ?? null,
              priceAsOf: price.asOf,
              priceExpiresAt: symExpiresAt,
            })
            .onConflictDoUpdate({
              target: [tokens.source, tokens.identifier],
              // 不动 provider_logo(备用槽只由 provider 采集路径写)
              set: {
                symbol: info.symbol,
                name: info.name,
                logo: info.logo ?? null,
                marketCapRank: price.marketCapRank ?? null,
                infoExpiresAt,
                unitPrice: price.unitPrice,
                change24h: price.change24h ?? null,
                priceAsOf: price.asOf,
                priceExpiresAt: symExpiresAt,
              },
            }),
          db
            .insert(tokenIndex)
            .values({ kind: "symbol", key: info.symbol, tokenId: id, expiresAt: symExpiresAt })
            .onConflictDoUpdate({
              target: [tokenIndex.kind, tokenIndex.key, tokenIndex.tokenId],
              set: { expiresAt: symExpiresAt },
            }),
        );
      }
      stmts.push(
        db
          .insert(tokenMeta)
          .values({ k: warmKey, v: t })
          .onConflictDoUpdate({ target: tokenMeta.k, set: { v: t } }),
      );
      const [first, ...rest] = stmts;
      await db.batch([first, ...rest]);
    },

    async warmAsOf(): Promise<number | null> {
      const rows = await db.select().from(tokenMeta).where(eq(tokenMeta.k, warmKey));
      return rows[0]?.v ?? null;
    },

    async listTopTokens(limit: number): Promise<TokenInfo[]> {
      // 当前 warm 集 = symbol 索引未过期;rank/name/logo 都在代币表。无 rank 者末尾。
      const t = now();
      const rows = await db
        .select({
          identifier: tokens.identifier,
          symbol: tokens.symbol,
          name: tokens.name,
          logo: tokens.logo,
        })
        .from(tokenIndex)
        .innerJoin(tokens, eq(tokens.id, tokenIndex.tokenId))
        .where(
          and(
            eq(tokenIndex.kind, "symbol"),
            gt(tokenIndex.expiresAt, t),
            eq(tokens.source, source),
            gt(tokens.infoExpiresAt, t),
          ),
        )
        .orderBy(sql`${tokens.marketCapRank} is null`, asc(tokens.marketCapRank))
        .limit(limit);
      return rows.map((r) => ({
        ref: mk(r.identifier),
        symbol: r.symbol,
        name: r.name,
        logo: r.logo ?? undefined,
      }));
    },

    async getByTokenKey(keys) {
      const out = new Map<string, TokenRecord & { cgkCheckedUntil: number | null }>();
      for (const ks of chunk(keys, IN_CHUNK)) {
        const rows = await db
          .select({ idx: tokenIndex, tok: tokens })
          .from(tokenIndex)
          .innerJoin(tokens, eq(tokens.id, tokenIndex.tokenId))
          .where(
            and(
              eq(tokenIndex.kind, "tokenKey"),
              inArray(tokenIndex.key, ks),
              gt(tokenIndex.expiresAt, now()),
            ),
          );
        for (const r of rows) {
          out.set(r.idx.key, { ...toRecord(r.tok), cgkCheckedUntil: r.idx.cgkCheckedUntil });
        }
      }
      return out;
    },

    async ensureTokenKey(key, seed: ProviderTokenSeed, indexTtlMs) {
      const t = now();
      const expiresAt = t + indexTtlMs;
      const cur = await db
        .select({ idx: tokenIndex, tok: tokens })
        .from(tokenIndex)
        .innerJoin(tokens, eq(tokens.id, tokenIndex.tokenId))
        .where(and(eq(tokenIndex.kind, "tokenKey"), eq(tokenIndex.key, key)));

      if (cur[0]) {
        const tok = cur[0].tok;
        const stmts: Stmt[] = [
          db
            .update(tokenIndex)
            .set({ expiresAt })
            .where(and(eq(tokenIndex.kind, "tokenKey"), eq(tokenIndex.key, key))),
        ];
        if (tok.source === source) {
          // cgk 行:只补/刷备用槽(provider 图更新鲜)
          if (seed.providerLogo) {
            stmts.push(
              db
                .update(tokens)
                .set({ providerLogo: seed.providerLogo })
                .where(eq(tokens.id, tok.id)),
            );
          }
        } else {
          // 孤儿行:provider 数据即其全部,整体刷新 + 顺延 info TTL
          stmts.push(
            db
              .update(tokens)
              .set({
                symbol: seed.symbol,
                name: seed.name ?? tok.name,
                providerLogo: seed.providerLogo ?? tok.providerLogo,
                infoExpiresAt: expiresAt,
              })
              .where(eq(tokens.id, tok.id)),
          );
        }
        const [first, ...rest] = stmts;
        await db.batch([first, ...rest]);
        return;
      }

      // miss → seed 孤儿行 + 索引行
      const id = crypto.randomUUID();
      await db.batch([
        db
          .insert(tokens)
          .values({
            id,
            source: PROVIDER_SOURCE,
            identifier: key,
            symbol: seed.symbol,
            name: seed.name ?? seed.symbol,
            providerLogo: seed.providerLogo ?? null,
            infoExpiresAt: expiresAt,
          })
          .onConflictDoUpdate({
            target: [tokens.source, tokens.identifier],
            set: {
              symbol: seed.symbol,
              name: seed.name ?? seed.symbol,
              providerLogo: seed.providerLogo ?? null,
              infoExpiresAt: expiresAt,
            },
          }),
        db.insert(tokenIndex).values({ kind: "tokenKey", key, tokenId: id, expiresAt }),
      ]);
    },

    async markCgkChecked(key, until) {
      await db
        .update(tokenIndex)
        .set({ cgkCheckedUntil: until })
        .where(and(eq(tokenIndex.kind, "tokenKey"), eq(tokenIndex.key, key)));
    },

    async linkTokenKeyToCgk(key, info, price, ttls) {
      const t = now();
      // 现指针与其代币(可能是孤儿)
      const cur = await db
        .select({ idx: tokenIndex, tok: tokens })
        .from(tokenIndex)
        .innerJoin(tokens, eq(tokens.id, tokenIndex.tokenId))
        .where(and(eq(tokenIndex.kind, "tokenKey"), eq(tokenIndex.key, key)));
      const orphan = cur[0] && cur[0].tok.source !== source ? cur[0].tok : null;
      // find-or-create cgk 行
      const existing = await db
        .select({ id: tokens.id })
        .from(tokens)
        .where(and(eq(tokens.source, source), eq(tokens.identifier, info.ref.identifier)));
      const cgkId = existing[0]?.id ?? crypto.randomUUID();
      const carryLogo = orphan?.providerLogo ?? null;

      const priceFields = price
        ? {
            unitPrice: price.unitPrice,
            change24h: price.change24h ?? null,
            marketCapRank: price.marketCapRank ?? null,
            priceAsOf: price.asOf,
            priceExpiresAt: t + ttls.priceTtlMs,
          }
        : {};
      const stmts: Stmt[] = [
        db
          .insert(tokens)
          .values({
            id: cgkId,
            source: info.ref.source,
            identifier: info.ref.identifier,
            symbol: info.symbol,
            name: info.name,
            logo: info.logo ?? null,
            providerLogo: carryLogo,
            infoExpiresAt: t + ttls.infoTtlMs,
            ...priceFields,
          })
          .onConflictDoUpdate({
            target: [tokens.source, tokens.identifier],
            set: {
              symbol: info.symbol,
              name: info.name,
              logo: info.logo ?? null,
              infoExpiresAt: t + ttls.infoTtlMs,
              // 备用槽:已有则保留,空才接孤儿的
              providerLogo: sql`coalesce(${tokens.providerLogo}, ${carryLogo})`,
              ...priceFields,
            },
          }),
        // 指针重指:清旧(含孤儿指针)→ 插新
        db.delete(tokenIndex).where(and(eq(tokenIndex.kind, "tokenKey"), eq(tokenIndex.key, key))),
        db
          .insert(tokenIndex)
          .values({ kind: "tokenKey", key, tokenId: cgkId, expiresAt: t + ttls.indexTtlMs }),
      ];
      // 孤儿行删除(其余索引行经 ON DELETE CASCADE 级联;孤儿 identifier=本 key,唯一)
      if (orphan) stmts.push(db.delete(tokens).where(eq(tokens.id, orphan.id)));
      const [first, ...rest] = stmts;
      await db.batch([first, ...rest]);
    },

    async getByRefs(refs) {
      const out = new Map<string, TokenRecord>();
      const identifiers = refs.filter((r) => r.source === source).map((r) => r.identifier);
      for (const ids of chunk(identifiers, IN_CHUNK)) {
        const rows = await db
          .select()
          .from(tokens)
          .where(
            and(
              eq(tokens.source, source),
              inArray(tokens.identifier, ids),
              gt(tokens.infoExpiresAt, now()),
            ),
          );
        for (const r of rows) out.set(refKey(mk(r.identifier)), toRecord(r));
      }
      return out;
    },

    async putPrices(prices, ttlMs) {
      if (prices.length === 0) return;
      const priceExpiresAt = now() + ttlMs;
      const stmts = prices.map((p) =>
        db
          .update(tokens)
          .set({
            unitPrice: p.unitPrice,
            change24h: p.change24h ?? null,
            marketCapRank: p.marketCapRank ?? null,
            priceAsOf: p.asOf,
            priceExpiresAt,
          })
          .where(and(eq(tokens.source, p.ref.source), eq(tokens.identifier, p.ref.identifier))),
      );
      const [first, ...rest] = stmts;
      await db.batch([first, ...rest]);
    },
  };
}
