import { formatTokenRef, parseTokenRef } from "@folio/oracle-ref";
import type {
  ProviderTokenSeed,
  TokenCandidate,
  TokenInfo,
  TokenInfoPatch,
  TokenRef,
  TokenRefHit,
  TokenStore,
} from "@folio/oracle2-basic";
import { and, eq, inArray, or, sql } from "drizzle-orm";
import { batchWrite, chunk } from "./cache-util";
import { type DbEnv, getDb } from "./client";
import { snapshotBalances, tokenRefs, tokens } from "./schema";

// `TokenStore` 的 D1 实现(ADR 0021 / 0023,#199)。**每个用户一份** —— userId 由工厂吃掉,
// 下面所有方法签名里都没有它,拿错用户在编译期就发生不了。
//
// 落两张表:`tokens`(info facet,含 user_id)+ `token_refs`(该用户对各命名者叫法的映射)。
// 价 facet 在 `createUserTokenPriceStore`(同一行的另外几列 + 另一张日价表)。
//
// `namer` = 当前上游的 id。它只用来回答一件事:「这个 Token 被上游认出来了吗」——
// 即有没有一条 namer 那一档的 ref 行(`TokenInfo.ref`)。本 store 不知道那是哪家。

export interface UserTokenStoreOpts {
  userId: string;
  namer: string; // 当前上游自报的 id(TokenUpstream.id);判 linked / 造 TokenInfo.ref 用
  now?: () => number; // 注入便于测;默认 Date.now
}

// D1 一条语句 ~100 个绑定参数上限。一条 ref 行按 (namer, local_name) 两段查 → 每条占 2 个参数,
// 外加 user_id 一个固定参数,故 40 条一批(81 个)稳在限内。
const REF_PAIR_CHUNK = 40;

// tokenRef 串 ↔ 两段列,拆/拼归文法包(见 @folio/oracle-ref)。
// 本文件因此**不认识右段的文法** —— 不知道有 `native` / `contract:` 这回事,也不知道分隔符是什么:
// 拆只取 parse 的那两段、`kind` 一眼不看,拼走 formatTokenRef 的两段形。
// 读不懂的串没有两段可拆 → 返回 undefined,不进表,读写都跳过。
const partsOf = (ref: string): { namer: string; localName: string } | undefined => {
  const parsed = parseTokenRef(ref);
  return parsed.kind === "unknown" ? undefined : parsed;
};
const refOf = (namer: string, localName: string) => formatTokenRef({ namer, localName });

export function createUserTokenStore(env: DbEnv, opts: UserTokenStoreOpts): TokenStore {
  const db = getDb(env);
  const { userId, namer } = opts;
  const now = opts.now ?? (() => Date.now());

  // 一批 ref 的 where:(namer=? AND local_name=?) OR … 。全部同属本用户,故 user_id 一次即可。
  const whereRefs = (pairs: { namer: string; localName: string }[]) =>
    and(
      eq(tokenRefs.userId, userId),
      or(
        ...pairs.map((p) =>
          and(eq(tokenRefs.namer, p.namer), eq(tokenRefs.localName, p.localName)),
        ),
      ),
    );

  // 这些 Token 里,哪些已经有当前上游那一档的 ref 行(= 已被认出)。
  async function linkedAmong(tokenIds: string[]): Promise<Set<string>> {
    const out = new Set<string>();
    for (const part of chunk([...new Set(tokenIds)])) {
      if (part.length === 0) continue;
      const rows = await db
        .select({ tokenId: tokenRefs.tokenId })
        .from(tokenRefs)
        .where(
          and(
            eq(tokenRefs.userId, userId),
            eq(tokenRefs.namer, namer),
            inArray(tokenRefs.tokenId, part),
          ),
        );
      for (const r of rows) out.add(r.tokenId);
    }
    return out;
  }

  // 一批 Token 的「上游叫法」(TokenInfo.ref)。没有那一档的 ref 行 → 不在返回里 → ref 为 null。
  async function upstreamRefs(tokenIds: string[]): Promise<Map<string, TokenRef>> {
    const out = new Map<string, TokenRef>();
    for (const part of chunk([...new Set(tokenIds)])) {
      if (part.length === 0) continue;
      const rows = await db
        .select({ tokenId: tokenRefs.tokenId, localName: tokenRefs.localName })
        .from(tokenRefs)
        .where(
          and(
            eq(tokenRefs.userId, userId),
            eq(tokenRefs.namer, namer),
            inArray(tokenRefs.tokenId, part),
          ),
        );
      // 同一个 Token 在一个命名者下应当只有一行(见 linkRef);真出了两行也给一个确定答案。
      for (const r of rows) if (!out.has(r.tokenId)) out.set(r.tokenId, refOf(namer, r.localName));
    }
    return out;
  }

  const toInfo = (
    r: {
      id: string;
      symbol: string;
      name: string;
      logo: string | null;
      providerLogo: string | null;
    },
    ref: TokenRef | null,
  ): TokenInfo => ({
    id: r.id,
    ref,
    symbol: r.symbol,
    name: r.name,
    logo: r.logo ?? undefined,
    providerLogo: r.providerLogo ?? undefined,
  });

  async function readInfos(ids: readonly string[]): Promise<Map<string, TokenInfo>> {
    const out = new Map<string, TokenInfo>();
    if (ids.length === 0) return out;
    const rows: {
      id: string;
      symbol: string;
      name: string;
      logo: string | null;
      providerLogo: string | null;
    }[] = [];
    for (const part of chunk([...new Set(ids)])) {
      if (part.length === 0) continue;
      rows.push(
        ...(await db
          .select({
            id: tokens.id,
            symbol: tokens.symbol,
            name: tokens.name,
            logo: tokens.logo,
            providerLogo: tokens.providerLogo,
          })
          .from(tokens)
          .where(and(eq(tokens.userId, userId), inArray(tokens.id, part)))),
      );
    }
    const refs = await upstreamRefs(rows.map((r) => r.id));
    for (const r of rows) out.set(r.id, toInfo(r, refs.get(r.id) ?? null));
    return out;
  }

  return {
    async findByRefs(input) {
      const out = new Map<TokenRef, TokenRefHit>();
      if (input.length === 0) return out;
      // 拆成两段;读不懂的串不进表,直接不返回(调用方按 miss 处理)。
      const pairs: { ref: TokenRef; namer: string; localName: string }[] = [];
      for (const ref of new Set(input)) {
        const p = partsOf(ref);
        if (p) pairs.push({ ref, ...p });
      }
      if (pairs.length === 0) return out;

      const found: { ref: TokenRef; tokenId: string }[] = [];
      for (const part of chunk(pairs, REF_PAIR_CHUNK)) {
        if (part.length === 0) continue;
        const rows = await db
          .select({
            namer: tokenRefs.namer,
            localName: tokenRefs.localName,
            tokenId: tokenRefs.tokenId,
          })
          .from(tokenRefs)
          .where(whereRefs(part));
        for (const r of rows) found.push({ ref: refOf(r.namer, r.localName), tokenId: r.tokenId });
      }
      const linked = await linkedAmong(found.map((f) => f.tokenId));
      for (const f of found) {
        out.set(f.ref, { tokenId: f.tokenId, linked: linked.has(f.tokenId) });
      }
      return out;
    },

    // **幂等**:账户并发跑,同一条 ref 会被同时 mint。先插 ref 行(冲突不动)再读回 ——
    // 谁先插谁的 token_id 生效,后来者读到的就是那一个,自己刚建的 tokens 行没人引用、无害。
    async create(seed: ProviderTokenSeed, newRefs) {
      const pairs = [...new Set(newRefs)].flatMap((ref) => {
        const p = partsOf(ref);
        return p ? [p] : [];
      });
      const id = crypto.randomUUID();
      await batchWrite(db, [
        db.insert(tokens).values({
          id,
          userId,
          symbol: seed.symbol,
          name: seed.name ?? seed.symbol,
          providerLogo: seed.providerLogo ?? null,
          // info TTL 沿用旧列(非空约束);新参考层不按它门控读(见 getByIds 注释)。
          infoExpiresAt: now(),
        }),
        ...pairs.map((p) =>
          db
            .insert(tokenRefs)
            .values({ userId, namer: p.namer, localName: p.localName, tokenId: id })
            // 主键冲突 = 已有人建过这个币 → 保留先到者,本次的 tokens 行成为无人引用的孤行。
            .onConflictDoNothing({
              target: [tokenRefs.userId, tokenRefs.namer, tokenRefs.localName],
            }),
        ),
      ]);
      if (pairs.length === 0) return id;
      // upsert-then-read:读回这些 ref 最终指向谁。
      const rows = await db
        .select({ tokenId: tokenRefs.tokenId })
        .from(tokenRefs)
        .where(whereRefs(pairs));
      const winner = rows[0]?.tokenId ?? id;
      // 自己没抢到 → 把刚建的孤行删掉,别在表里留垃圾。
      if (winner !== id) await db.delete(tokens).where(eq(tokens.id, id));
      return winner;
    },

    async linkRef(tokenId, ref) {
      const p = partsOf(ref);
      if (!p) return tokenId;
      // 「一个 Token 在一个命名者下最多一条 ref」在这里保证(不做部分唯一索引,见 schema.ts):
      // 已经有那一档了就什么都不做 —— 挡住合并写错把两个上游币挂到同一行。
      const existing = await db
        .select({ tokenId: tokenRefs.tokenId, localName: tokenRefs.localName })
        .from(tokenRefs)
        .where(
          and(
            eq(tokenRefs.userId, userId),
            or(
              and(eq(tokenRefs.namer, p.namer), eq(tokenRefs.localName, p.localName)),
              and(eq(tokenRefs.namer, p.namer), eq(tokenRefs.tokenId, tokenId)),
            ),
          ),
        );
      // 这条 ref 已有主 → 返回它的主(幂等;可能不是传进来的 tokenId)。
      const owner = existing.find((r) => r.localName === p.localName);
      if (owner) return owner.tokenId;
      // 这个 Token 在该命名者下已有别的叫法 → 不加第二条。
      if (existing.length > 0) return tokenId;
      await db
        .insert(tokenRefs)
        .values({ userId, namer: p.namer, localName: p.localName, tokenId })
        .onConflictDoNothing({
          target: [tokenRefs.userId, tokenRefs.namer, tokenRefs.localName],
        });
      return tokenId;
    },

    // 合并:ref 改指 + **历史快照的 token_id 一并改指** + 旧行删除。
    // 身份可变、金额不变 —— 不改历史行的话曲线会在合并那一刻断成两段。
    //
    // `from` 的价随 tokens 行一起消失(价 facet 就在那一行上);**历史日价不用管** ——
    // 它按 tokenRef 全局存,与 token_id 无关,赢家读的就是同一批行,曲线一格都不缺。
    async merge(from, into) {
      if (from === into) return;
      // ref 行改指:`into` 已有同一 (namer, local_name) 的话主键会撞 → 先删掉 `from` 那边的重复项。
      const [fromRefs, intoRefs] = await Promise.all([
        db
          .select({ namer: tokenRefs.namer, localName: tokenRefs.localName })
          .from(tokenRefs)
          .where(and(eq(tokenRefs.userId, userId), eq(tokenRefs.tokenId, from))),
        db
          .select({ namer: tokenRefs.namer, localName: tokenRefs.localName })
          .from(tokenRefs)
          .where(and(eq(tokenRefs.userId, userId), eq(tokenRefs.tokenId, into))),
      ]);
      const taken = new Set(intoRefs.map((r) => `${r.namer}/${r.localName}`));
      const dupes = fromRefs.filter((r) => taken.has(`${r.namer}/${r.localName}`));

      const stmts = [
        ...dupes.map((d) =>
          db
            .delete(tokenRefs)
            .where(
              and(
                eq(tokenRefs.userId, userId),
                eq(tokenRefs.tokenId, from),
                eq(tokenRefs.namer, d.namer),
                eq(tokenRefs.localName, d.localName),
              ),
            ),
        ),
        db
          .update(tokenRefs)
          .set({ tokenId: into })
          .where(and(eq(tokenRefs.userId, userId), eq(tokenRefs.tokenId, from))),
        // 历史快照改指。snapshot_balances 上没有 user_id 列,但 token_id 是本用户的 UUID,
        // 只可能出现在本用户的行上 —— 按它直接改指即可。
        db
          .update(snapshotBalances)
          .set({ tokenId: into })
          .where(eq(snapshotBalances.tokenId, from)),
        // 旧行的 provider 图是展示回退链的一档,别随行一起丢(只填空槽)。
        db
          .update(tokens)
          .set({
            providerLogo: sql`coalesce(${tokens.providerLogo}, (select provider_logo from ${tokens} where id = ${from}))`,
          })
          .where(eq(tokens.id, into)),
        db.delete(tokens).where(and(eq(tokens.userId, userId), eq(tokens.id, from))),
      ];
      await batchWrite(db, stmts);
    },

    // **不门控 info TTL** —— 只要行在就给。门控了会渲染出 logo 代理 URL 却在端点上 404。
    getByIds: readInfos,

    async getById(id) {
      return (await readInfos([id])).get(id);
    },

    async fillInfo(tokenId, patch: TokenInfoPatch) {
      // 只填空槽:undefined 的字段不动,**已有值的字段也不动**(那可能是上游的好数据)。
      const set: Record<string, unknown> = {};
      if (patch.name !== undefined)
        set.name = sql`coalesce(nullif(${tokens.name}, ''), ${patch.name})`;
      if (patch.logo !== undefined) set.logo = sql`coalesce(${tokens.logo}, ${patch.logo})`;
      if (patch.providerLogo !== undefined) {
        set.providerLogo = sql`coalesce(${tokens.providerLogo}, ${patch.providerLogo})`;
      }
      if (Object.keys(set).length === 0) return;
      await db
        .update(tokens)
        .set(set)
        .where(and(eq(tokens.userId, userId), eq(tokens.id, tokenId)));
    },

    // 「本地已认识的同名币」。服务层的 symbol 消歧主路走 warm blob 筛(见 oracle2 的 cache.ts),
    // 这里只是另一条路:本用户已有的、且已被上游认出的同 symbol 币。
    async candidatesBySymbol(symbol): Promise<TokenCandidate[]> {
      const rows = await db
        .select({
          localName: tokenRefs.localName,
          marketCapRank: tokens.marketCapRank,
        })
        .from(tokens)
        .innerJoin(tokenRefs, and(eq(tokenRefs.tokenId, tokens.id), eq(tokenRefs.namer, namer)))
        .where(and(eq(tokens.userId, userId), eq(tokens.symbol, symbol)));
      return rows.map((r) => ({
        ref: refOf(namer, r.localName),
        marketCapRank: r.marketCapRank ?? undefined,
      }));
    },
  };
}
