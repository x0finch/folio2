import {
  GROUP_MEMBERSHIP,
  type ProviderTokenSeed,
  refKey,
  TOKEN_GROUPS,
  type TokenCandidate,
  type TokenInfo,
  type TokenPrice,
  type TokenRecord,
  type TokenRecordPrice,
  type TokenRef,
  type TokenStore,
} from "@folio/tokens";
import { and, asc, eq, gt, inArray, sql } from "drizzle-orm";
import { chunk, IN_CHUNK } from "./cache-util";
import { type DbEnv, getDb } from "./client";
import { tokenGroups, tokenIndex, tokenMeta, tokens, tokenVendorIds } from "./schema";

export interface TokenStoreOpts {
  source: TokenRef["source"]; // store 绑定的规范源(如 "coingecko");ref 只对该源的映射成立
  now?: () => number; // 注入便于测 TTL;默认 Date.now
}

type TokenRow = typeof tokens.$inferSelect;

// 代币表 + 索引表 + vendor 映射表的 D1 实现(无 userId;全局参考数据)。只经此工厂访问,不外泄 db/schema。
// 归并身份 = tokens.id(vendor 中立,#73)。各家 coin id 存 token_vendor_ids(vendor, vendorId)→tokenId;
// 本 store 绑定 source(如 "coingecko"):按 (source, vendorId) 找/挂映射,ref = 该映射的 vendorId。
// 孤儿行(CGK 未收录、provider 采集)= 无 vendor 映射行,其 tokenKey 关联只在 token_index。
// 并发注记:putWarm/ensureTokenKey 先查后批写,极端并发下(cron 与手动 sync 同拍)可能出重复孤儿行/
// 索引 FK 失败回滚 —— 下次 warm/sync(cur 命中其一走刷新路径)或升级合并(linkTokenKeyToCgk 删孤儿)自愈,
// 可接受(warm 已单飞)。孤儿去重原靠 (source,identifier) 列唯一,去 vendor tag 后改由 token_index 的
// cur 检查兜底(best-effort,自愈)。
export function createTokenStore(env: DbEnv, opts: TokenStoreOpts): TokenStore {
  const db = getDb(env);
  type Batch = Parameters<typeof db.batch>[0]; // [Stmt, ...Stmt[]];Stmt = drizzle BatchItem
  type Stmt = Batch[number];
  const source = opts.source;
  const now = opts.now ?? (() => Date.now());
  // source↔identifier 品牌对齐由本源(opts.source)保证 → 整体 as TokenRef(可信边界)。
  const mk = (vendorId: string): TokenRef => ({ source, identifier: vendorId }) as TokenRef;
  const warmKey = `warm_as_of:${source}`;

  // 展示分组(P2):groupKey 直接当 token_groups.id(text PK,deterministic,免 find-or-create)。
  const groupIdFor = (vendorId: string): string | null => GROUP_MEMBERSHIP[vendorId] ?? null;
  const groupUpsert = (groupKey: string): Stmt => {
    const def = TOKEN_GROUPS[groupKey as keyof typeof TOKEN_GROUPS];
    return db
      .insert(tokenGroups)
      .values({ id: groupKey, displaySymbol: def.displaySymbol, name: def.name })
      .onConflictDoUpdate({
        target: tokenGroups.id,
        set: { displaySymbol: def.displaySymbol, name: def.name },
      });
  };
  // 挂本源 vendor 映射(tokenId ← vendorId)。映射稳定,冲突即已存 → DoNothing(不动已有价)。
  const vendorMapUpsert = (tokenId: string, vendorId: string): Stmt =>
    db
      .insert(tokenVendorIds)
      .values({ tokenId, vendor: source, vendorId })
      .onConflictDoNothing({ target: [tokenVendorIds.vendor, tokenVendorIds.vendorId] });
  // 挂映射并写本源价(per-vendor,#93):映射不存在则建、存在则只刷价列(不碰别源那行)。
  const vendorPriceUpsert = (
    tokenId: string,
    vendorId: string,
    p: TokenPrice,
    ttlMs: number,
  ): Stmt => {
    const priceFields = {
      unitPrice: p.unitPrice,
      change24h: p.change24h ?? null,
      priceAsOf: p.asOf,
      priceExpiresAt: now() + ttlMs,
    };
    return db
      .insert(tokenVendorIds)
      .values({ tokenId, vendor: source, vendorId, ...priceFields })
      .onConflictDoUpdate({
        target: [tokenVendorIds.vendor, tokenVendorIds.vendorId],
        set: priceFields,
      });
  };
  // 读时 join 出的组列(leftJoin 未命中则各列为 null)。
  type GrpSel = {
    id: string | null;
    displaySymbol: string | null;
    name: string | null;
    logo: string | null;
  };
  const grpCols = {
    id: tokenGroups.id,
    displaySymbol: tokenGroups.displaySymbol,
    name: tokenGroups.name,
    logo: tokenGroups.logo,
  };
  // 读时 join 出的本源 vendor 映射列(含 per-vendor 价;leftJoin 未命中则各列 null = 孤儿/无本源映射)。
  type VpSel = {
    vendorId: string | null;
    unitPrice: number | null;
    change24h: number | null;
    priceAsOf: number | null;
    priceExpiresAt: number | null;
  };
  const vpCols = {
    vendorId: tokenVendorIds.vendorId,
    unitPrice: tokenVendorIds.unitPrice,
    change24h: tokenVendorIds.change24h,
    priceAsOf: tokenVendorIds.priceAsOf,
    priceExpiresAt: tokenVendorIds.priceExpiresAt,
  };

  // 行 → 领域记录。ref + 价均由本源 vendor 映射行(vp)构造(孤儿/无本源映射 → ref null、无价)。
  // 价过期不删:读出带 stale(SWR)。grp 命中(id 非空)才挂 group(leftJoin,未命中整体 null)。
  const toRecord = (r: TokenRow, grp?: GrpSel | null, vp?: VpSel | null): TokenRecord => ({
    id: r.id,
    ref: vp?.vendorId != null ? mk(vp.vendorId) : null,
    symbol: r.symbol,
    name: r.name,
    logo: r.logo ?? undefined,
    providerLogo: r.providerLogo ?? undefined,
    marketCapRank: r.marketCapRank ?? undefined,
    price:
      vp?.vendorId != null && vp.unitPrice != null && vp.priceAsOf != null
        ? {
            unitPrice: vp.unitPrice,
            change24h: vp.change24h ?? undefined,
            asOf: vp.priceAsOf,
            stale: (vp.priceExpiresAt ?? 0) <= now(),
          }
        : undefined,
    group:
      grp && grp.id != null && grp.displaySymbol != null && grp.name != null
        ? {
            id: grp.id,
            displaySymbol: grp.displaySymbol,
            name: grp.name,
            logo: grp.logo ?? undefined,
          }
        : undefined,
  });

  // 预取一批 (本源, vendorId) 的现有 tokenId;miss 的由调用侧预分配 UUID。
  async function existingIds(vendorIds: string[]): Promise<Map<string, string>> {
    const out = new Map<string, string>();
    for (const ids of chunk(vendorIds, IN_CHUNK)) {
      const rows = await db
        .select({ tokenId: tokenVendorIds.tokenId, vendorId: tokenVendorIds.vendorId })
        .from(tokenVendorIds)
        .where(and(eq(tokenVendorIds.vendor, source), inArray(tokenVendorIds.vendorId, ids)));
      for (const r of rows) out.set(r.vendorId, r.tokenId);
    }
    return out;
  }

  return {
    async getCandidates(symbol: string): Promise<TokenCandidate[]> {
      // `symbol` 视为已归一(调用方 @folio/tokens 保证);store 只按 key 点查。
      // innerJoin vendor 映射(本源)→ 只出有本源映射的候选。
      const rows = await db
        .select({ vendorId: tokenVendorIds.vendorId, rank: tokens.marketCapRank })
        .from(tokenIndex)
        .innerJoin(tokens, eq(tokens.id, tokenIndex.tokenId))
        .innerJoin(
          tokenVendorIds,
          and(eq(tokenVendorIds.tokenId, tokens.id), eq(tokenVendorIds.vendor, source)),
        )
        .where(
          and(
            eq(tokenIndex.kind, "symbol"),
            eq(tokenIndex.key, symbol),
            gt(tokenIndex.expiresAt, now()),
          ),
        );
      return rows.map((r) => ({ ref: mk(r.vendorId), marketCapRank: r.rank ?? undefined }));
    },

    async putWarm(rows, warmTtlMs, infoTtlMs) {
      if (rows.length === 0) return;
      const t = now();
      const symExpiresAt = t + warmTtlMs; // symbol 索引 + 价(短)
      const infoExpiresAt = t + infoTtlMs; // name/logo(长)
      const ids = await existingIds(rows.map((r) => r.info.ref.identifier));
      const stmts: Stmt[] = [];
      const groupKeys = new Set<string>(); // 需 upsert 的组(去重,置于批首满足 FK)
      for (const { info, price } of rows) {
        const id = ids.get(info.ref.identifier) ?? crypto.randomUUID();
        const groupId = groupIdFor(info.ref.identifier);
        if (groupId) groupKeys.add(groupId);
        stmts.push(
          db
            .insert(tokens)
            .values({
              id,
              symbol: info.symbol,
              name: info.name,
              logo: info.logo ?? null,
              marketCapRank: price.marketCapRank ?? null,
              groupId,
              infoExpiresAt,
            })
            .onConflictDoUpdate({
              target: tokens.id,
              // 不动 provider_logo(备用槽只由 provider 采集路径写)
              set: {
                symbol: info.symbol,
                name: info.name,
                logo: info.logo ?? null,
                marketCapRank: price.marketCapRank ?? null,
                groupId,
                infoExpiresAt,
              },
            }),
          // vendor 映射 + 本源价(per-vendor);已存则刷价。FK 要求 tokens 先在,故置于其后。
          vendorPriceUpsert(id, info.ref.identifier, price, warmTtlMs),
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
      // 组行 upsert 置于批首(tokens.group_id → token_groups.id 的 FK 要求组先在)。
      const [first, ...rest] = [...[...groupKeys].map(groupUpsert), ...stmts];
      await db.batch([first, ...rest]);
    },

    async warmAsOf(): Promise<number | null> {
      const rows = await db.select().from(tokenMeta).where(eq(tokenMeta.k, warmKey));
      return rows[0]?.v ?? null;
    },

    async listTopTokens(limit: number): Promise<TokenInfo[]> {
      // 当前 warm 集 = symbol 索引未过期;rank/name/logo 都在代币表。无 rank 者末尾。
      // innerJoin vendor 映射(本源)→ 只出有本源映射的行,并取 vendorId 造 ref。
      const t = now();
      const rows = await db
        .select({
          id: tokens.id,
          vendorId: tokenVendorIds.vendorId,
          symbol: tokens.symbol,
          name: tokens.name,
          logo: tokens.logo,
        })
        .from(tokenIndex)
        .innerJoin(tokens, eq(tokens.id, tokenIndex.tokenId))
        .innerJoin(
          tokenVendorIds,
          and(eq(tokenVendorIds.tokenId, tokens.id), eq(tokenVendorIds.vendor, source)),
        )
        .where(
          and(
            eq(tokenIndex.kind, "symbol"),
            gt(tokenIndex.expiresAt, t),
            gt(tokens.infoExpiresAt, t),
          ),
        )
        .orderBy(sql`${tokens.marketCapRank} is null`, asc(tokens.marketCapRank))
        .limit(limit);
      return rows.map((r) => ({
        ref: mk(r.vendorId),
        id: r.id,
        symbol: r.symbol,
        name: r.name,
        logo: r.logo ?? undefined,
      }));
    },

    async getByTokenKey(keys) {
      const out = new Map<string, TokenRecord & { cgkCheckedUntil: number | null }>();
      for (const ks of chunk(keys, IN_CHUNK)) {
        const rows = await db
          .select({ idx: tokenIndex, tok: tokens, grp: grpCols, vp: vpCols })
          .from(tokenIndex)
          .innerJoin(tokens, eq(tokens.id, tokenIndex.tokenId))
          .leftJoin(tokenGroups, eq(tokenGroups.id, tokens.groupId))
          .leftJoin(
            tokenVendorIds,
            and(eq(tokenVendorIds.tokenId, tokens.id), eq(tokenVendorIds.vendor, source)),
          )
          .where(
            and(
              eq(tokenIndex.kind, "tokenKey"),
              inArray(tokenIndex.key, ks),
              gt(tokenIndex.expiresAt, now()),
            ),
          );
        for (const r of rows) {
          out.set(r.idx.key, {
            ...toRecord(r.tok, r.grp, r.vp),
            cgkCheckedUntil: r.idx.cgkCheckedUntil,
          });
        }
      }
      return out;
    },

    async ensureTokenKey(key, seed: ProviderTokenSeed, indexTtlMs) {
      const t = now();
      const expiresAt = t + indexTtlMs;
      // 现指针指向的代币,并 leftJoin 本源映射判断它是否 cgk 行(有映射)还是孤儿(无映射)。
      const cur = await db
        .select({ tok: tokens, vendorId: tokenVendorIds.vendorId })
        .from(tokenIndex)
        .innerJoin(tokens, eq(tokens.id, tokenIndex.tokenId))
        .leftJoin(
          tokenVendorIds,
          and(eq(tokenVendorIds.tokenId, tokens.id), eq(tokenVendorIds.vendor, source)),
        )
        .where(and(eq(tokenIndex.kind, "tokenKey"), eq(tokenIndex.key, key)));

      if (cur[0]) {
        const tok = cur[0].tok;
        const isCgk = cur[0].vendorId != null;
        const stmts: Stmt[] = [
          db
            .update(tokenIndex)
            .set({ expiresAt })
            .where(and(eq(tokenIndex.kind, "tokenKey"), eq(tokenIndex.key, key))),
        ];
        if (isCgk) {
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

      // miss → seed 孤儿行(无 vendor 映射)+ 索引行
      const id = crypto.randomUUID();
      await db.batch([
        db.insert(tokens).values({
          id,
          symbol: seed.symbol,
          name: seed.name ?? seed.symbol,
          providerLogo: seed.providerLogo ?? null,
          infoExpiresAt: expiresAt,
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
      // find-or-create 本源 canonical 行:按本源 vendor 映射找 tokenId。
      const mapped = await db
        .select({ tokenId: tokenVendorIds.tokenId })
        .from(tokenVendorIds)
        .where(
          and(eq(tokenVendorIds.vendor, source), eq(tokenVendorIds.vendorId, info.ref.identifier)),
        );

      // 现指针与其代币。
      const cur = await db
        .select({ tok: tokens })
        .from(tokenIndex)
        .innerJoin(tokens, eq(tokens.id, tokenIndex.tokenId))
        .where(and(eq(tokenIndex.kind, "tokenKey"), eq(tokenIndex.key, key)));
      const curRow = cur[0]?.tok ?? null;

      // 跨源重锚(#83 换源不碎):本源尚无该 coin 映射,但 tokenKey 已指向某源已建的 canonical 行
      //(有任意 vendor 映射)→ 复用**同一内部 id**、只挂本源映射 + 刷价,不覆盖别源已有的
      // name/logo/symbol(本源可能是只供价的 DefiLlama,元信息权威留 baseline)。
      if (!mapped[0] && curRow) {
        const anyMap = await db
          .select({ v: tokenVendorIds.vendor })
          .from(tokenVendorIds)
          .where(eq(tokenVendorIds.tokenId, curRow.id))
          .limit(1);
        if (anyMap.length > 0) {
          // 只挂本源映射 + 写本源那格价(per-vendor);绝不碰 tokens 的 name/logo/rank(baseline 权威)。
          const stmts: Stmt[] = [
            price
              ? vendorPriceUpsert(curRow.id, info.ref.identifier, price, ttls.priceTtlMs)
              : vendorMapUpsert(curRow.id, info.ref.identifier),
            db
              .update(tokenIndex)
              .set({ expiresAt: t + ttls.indexTtlMs })
              .where(and(eq(tokenIndex.kind, "tokenKey"), eq(tokenIndex.key, key))),
          ];
          const [first, ...rest] = stmts;
          await db.batch([first, ...rest]);
          return;
        }
      }

      const cgkId = mapped[0]?.tokenId ?? crypto.randomUUID();
      // 若现指针指向的不是本源 canonical 行(id 不同 → 无本源映射的孤儿),即待合并删除的孤儿。
      const orphan = curRow && curRow.id !== cgkId ? curRow : null;
      const carryLogo = orphan?.providerLogo ?? null;
      const groupId = groupIdFor(info.ref.identifier);

      // rank 是全局身份事实,留 tokens;仅本源带价(带 rank)时刷新,否则不动既有 rank。
      const rankField = price?.marketCapRank != null ? { marketCapRank: price.marketCapRank } : {};
      const stmts: Stmt[] = [
        db
          .insert(tokens)
          .values({
            id: cgkId,
            symbol: info.symbol,
            name: info.name,
            logo: info.logo ?? null,
            providerLogo: carryLogo,
            groupId,
            infoExpiresAt: t + ttls.infoTtlMs,
            ...rankField,
          })
          .onConflictDoUpdate({
            target: tokens.id,
            set: {
              symbol: info.symbol,
              name: info.name,
              logo: info.logo ?? null,
              groupId,
              infoExpiresAt: t + ttls.infoTtlMs,
              // 备用槽:已有则保留,空才接孤儿的
              providerLogo: sql`coalesce(${tokens.providerLogo}, ${carryLogo})`,
              ...rankField,
            },
          }),
        // 挂本源 vendor 映射 + 本源那格价(FK:需 cgk 行先在);无价则只挂映射。
        price
          ? vendorPriceUpsert(cgkId, info.ref.identifier, price, ttls.priceTtlMs)
          : vendorMapUpsert(cgkId, info.ref.identifier),
        // 指针重指:清旧(含孤儿指针)→ 插新
        db.delete(tokenIndex).where(and(eq(tokenIndex.kind, "tokenKey"), eq(tokenIndex.key, key))),
        db
          .insert(tokenIndex)
          .values({ kind: "tokenKey", key, tokenId: cgkId, expiresAt: t + ttls.indexTtlMs }),
      ];
      // 孤儿行删除(其余索引行 / vendor 映射经 ON DELETE CASCADE 级联)
      if (orphan) stmts.push(db.delete(tokens).where(eq(tokens.id, orphan.id)));
      // 组行 upsert 置于批首(FK:tokens.group_id → token_groups.id)。
      const [first, ...rest] = groupId ? [groupUpsert(groupId), ...stmts] : stmts;
      await db.batch([first, ...rest]);
    },

    async getByRefs(refs) {
      const out = new Map<string, TokenRecord>();
      const vendorIds = refs.filter((r) => r.source === source).map((r) => r.identifier);
      for (const ids of chunk(vendorIds, IN_CHUNK)) {
        const rows = await db
          .select({ tok: tokens, grp: grpCols, vp: vpCols })
          .from(tokenVendorIds)
          .innerJoin(tokens, eq(tokens.id, tokenVendorIds.tokenId))
          .leftJoin(tokenGroups, eq(tokenGroups.id, tokens.groupId))
          .where(
            and(
              eq(tokenVendorIds.vendor, source),
              inArray(tokenVendorIds.vendorId, ids),
              gt(tokens.infoExpiresAt, now()),
            ),
          );
        for (const r of rows)
          out.set(refKey(mk(r.vp.vendorId as string)), toRecord(r.tok, r.grp, r.vp));
      }
      return out;
    },

    async getById(id) {
      // 不门控 infoExpiresAt(与 getByRefs 不同):logo 端点按主键服务字节,只要行在就给。
      // 渲染 tokenKey 类持仓的 getByTokenKey 也不门控 info,若这里门控则 info 过期(30d)的
      // 长尾币会渲染出代理 URL 却在此 404。行删除(如升级合并删孤儿)才是唯一的"没有"。
      const rows = await db
        .select({ tok: tokens, grp: grpCols, vp: vpCols })
        .from(tokens)
        .leftJoin(tokenGroups, eq(tokenGroups.id, tokens.groupId))
        .leftJoin(
          tokenVendorIds,
          and(eq(tokenVendorIds.tokenId, tokens.id), eq(tokenVendorIds.vendor, source)),
        )
        .where(eq(tokens.id, id));
      const r = rows[0];
      return r ? toRecord(r.tok, r.grp, r.vp) : undefined;
    },

    async putPrices(prices, ttlMs) {
      if (prices.length === 0) return;
      const priceExpiresAt = now() + ttlMs;
      // 价写本源那格(per-vendor);只更新已存在的映射(id 命中)。rank 全局留 tokens,仅本源带 rank 时刷。
      const ids = await existingIds(prices.map((p) => p.ref.identifier));
      const stmts: Stmt[] = [];
      for (const p of prices) {
        const id = ids.get(p.ref.identifier);
        if (!id) continue;
        stmts.push(
          db
            .update(tokenVendorIds)
            .set({
              unitPrice: p.unitPrice,
              change24h: p.change24h ?? null,
              priceAsOf: p.asOf,
              priceExpiresAt,
            })
            .where(
              and(eq(tokenVendorIds.vendor, source), eq(tokenVendorIds.vendorId, p.ref.identifier)),
            ),
        );
        if (p.marketCapRank != null) {
          stmts.push(
            db.update(tokens).set({ marketCapRank: p.marketCapRank }).where(eq(tokens.id, id)),
          );
        }
      }
      if (stmts.length === 0) return;
      const [first, ...rest] = stmts;
      await db.batch([first, ...rest]);
    },

    async getPricesByIds(ids) {
      const out = new Map<string, TokenRecordPrice>();
      for (const batch of chunk(ids, IN_CHUNK)) {
        const rows = await db
          .select({
            tokenId: tokenVendorIds.tokenId,
            unitPrice: tokenVendorIds.unitPrice,
            change24h: tokenVendorIds.change24h,
            priceAsOf: tokenVendorIds.priceAsOf,
            priceExpiresAt: tokenVendorIds.priceExpiresAt,
          })
          .from(tokenVendorIds)
          .where(and(eq(tokenVendorIds.vendor, source), inArray(tokenVendorIds.tokenId, batch)));
        for (const r of rows) {
          if (r.unitPrice != null && r.priceAsOf != null) {
            out.set(r.tokenId, {
              unitPrice: r.unitPrice,
              change24h: r.change24h ?? undefined,
              asOf: r.priceAsOf,
              stale: (r.priceExpiresAt ?? 0) <= now(),
            });
          }
        }
      }
      return out;
    },
  };
}
