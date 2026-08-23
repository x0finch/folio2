import type {
  ProviderTokenSeed,
  TokenCandidate,
  TokenInfo,
  TokenInfoPatch,
  TokenRef,
  TokenRefHit,
} from "@folio/oracle-basic";
import { TokenStore } from "@folio/oracle-basic/ports";
import { formatTokenRef, parseTokenRef } from "@folio/oracle-ref";
import { and, eq, inArray, or, sql } from "drizzle-orm";
import { Clock, Effect, Layer, Option } from "effect";
import { chunk, DbClient } from "../client";
import type { Drizzle } from "../connect";
import { CurrentUser } from "../current-user";
import { snapshotBalances, tokenRefs, tokens } from "../schema";

// `TokenStore` 的 D1 实现(ADR 0021 / 0023,#199)。**每个用户一份** —— userId 由 layer 吃掉,
// 下面所有方法签名里都没有它,拿错用户在编译期就发生不了。
//
// 落两张表:`tokens`(info facet,含 user_id)+ `token_refs`(该用户对各命名者叫法的映射)。
// 价 facet 在 `./token-price`(同一行的另外几列 + 另一张日价表)。
//
// `namer` = 当前上游的 id。它只用来回答一件事:「这个 Token 被上游认出来了吗」——
// 即有没有一条 namer 那一档的 ref 行(`TokenInfo.ref`)。本 store 不知道那是哪家。
//
// **出网口只有 `DbClient` 一个服务**(见 ./service.ts):`env` 不在签名里,`Effect.promise` 不在
// 这个文件里,时间走 `Clock`(以前是 `opts.now` —— 只有测试会传的字段)。

export interface UserTokenStoreOpts {
  namer: string; // 当前上游自报的 id(TokenUpstream.id);判 linked / 造 TokenInfo.ref 用
}

// D1 一条语句 ~100 个绑定参数上限。一条 ref 行按 (namer, local_name) 两段查 → 每条占 2 个参数,
// 外加 user_id 一个固定参数,故 40 条一批(81 个)稳在限内。
const REF_PAIR_CHUNK = 40;

// 元信息覆盖写:逐行一条 UPDATE(symbol/name/logo/info_expires_at + user_id/id 两个 where
// = 每条最多 6 个参数,单条语句压根碰不到上限),真正约束的是一批发多少条语句。
// 一次刷的量级是「用户屏幕上的持仓数」(几十到几百),50 条一批 → 常见情形一两批打完。
const INFO_WRITES_PER_BATCH = 50;

// tokenRef 串 ↔ 两段列,拆/拼归文法包(见 @folio/oracle-ref)。
// 本文件因此**不认识右段的文法** —— 不知道有 `native` / `contract:` 这回事,也不知道分隔符是什么:
// 拆只取 parse 的那两段、`kind` 一眼不看,拼走 formatTokenRef 的两段形。
// 读不懂的串没有两段可拆 → 返回 undefined,不进表,读写都跳过。
const partsOf = (ref: string): { namer: string; localName: string } | undefined => {
  const parsed = parseTokenRef(ref);
  return parsed.kind === "unknown" ? undefined : parsed;
};

type InfoRow = {
  id: string;
  symbol: string;
  name: string;
  logo: string | null;
  providerLogo: string | null;
  infoExpiresAt: number;
};

const make = ({ namer }: UserTokenStoreOpts) =>
  Effect.gen(function* () {
    const client = yield* DbClient;
    const userId = yield* CurrentUser;

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
    const linkedAmong = (tokenIds: string[]): Effect.Effect<Set<string>> =>
      Effect.gen(function* () {
        const parts = chunk([...new Set(tokenIds)]).filter((p) => p.length > 0);
        const batches = yield* Effect.forEach(parts, (part) =>
          client.query((db) =>
            db
              .select({ tokenId: tokenRefs.tokenId })
              .from(tokenRefs)
              .where(
                and(
                  eq(tokenRefs.userId, userId),
                  eq(tokenRefs.namer, namer),
                  inArray(tokenRefs.tokenId, part),
                ),
              ),
          ),
        );
        const out = new Set<string>();
        for (const rows of batches) for (const r of rows) out.add(r.tokenId);
        return out;
      });

    // 一批 Token 的「上游叫法」(TokenInfo.ref)。没有那一档的 ref 行 → 不在返回里 → ref 为 null。
    const upstreamRefs = (tokenIds: string[]): Effect.Effect<Map<string, TokenRef>> =>
      Effect.gen(function* () {
        const parts = chunk([...new Set(tokenIds)]).filter((p) => p.length > 0);
        const batches = yield* Effect.forEach(parts, (part) =>
          client.query((db) =>
            db
              .select({ tokenId: tokenRefs.tokenId, localName: tokenRefs.localName })
              .from(tokenRefs)
              .where(
                and(
                  eq(tokenRefs.userId, userId),
                  eq(tokenRefs.namer, namer),
                  inArray(tokenRefs.tokenId, part),
                ),
              ),
          ),
        );
        const out = new Map<string, TokenRef>();
        // 同一个 Token 在一个命名者下应当只有一行(见 linkRef);真出了两行也给一个确定答案。
        for (const rows of batches) {
          for (const r of rows) {
            if (!out.has(r.tokenId)) {
              out.set(r.tokenId, formatTokenRef({ namer, localName: r.localName }));
            }
          }
        }
        return out;
      });

    // info 标成「该刷」= 把过期时刻推到过去。`putInfo` 的反面,不带值。
    const expireInfoStmt = (db: Drizzle, tokenId: string) =>
      db
        .update(tokens)
        .set({ infoExpiresAt: 0 })
        .where(and(eq(tokens.userId, userId), eq(tokens.id, tokenId)));

    const toInfo = (r: InfoRow, ref: TokenRef | null, now: number): TokenInfo => ({
      id: r.id,
      ref,
      symbol: r.symbol,
      name: r.name,
      logo: r.logo ?? undefined,
      providerLogo: r.providerLogo ?? undefined,
      // **过期不删、照样给**(与价同口径)—— 只是标出来让上层去刷,见下面 getByIds 的注释。
      infoStale: r.infoExpiresAt <= now,
    });

    const readInfos = (ids: readonly string[]): Effect.Effect<Map<string, TokenInfo>> =>
      Effect.gen(function* () {
        const out = new Map<string, TokenInfo>();
        if (ids.length === 0) return out;
        const parts = chunk([...new Set(ids)]).filter((p) => p.length > 0);
        const batches = yield* Effect.forEach(parts, (part) =>
          client.query(
            (db): PromiseLike<InfoRow[]> =>
              db
                .select({
                  id: tokens.id,
                  symbol: tokens.symbol,
                  name: tokens.name,
                  logo: tokens.logo,
                  providerLogo: tokens.providerLogo,
                  infoExpiresAt: tokens.infoExpiresAt,
                })
                .from(tokens)
                .where(and(eq(tokens.userId, userId), inArray(tokens.id, part))),
          ),
        );
        const rows = batches.flat();
        // 第二趟(拿这些 Token 的上游叫法)与「现在几点」互不依赖 → 一起走。
        const [refs, now] = yield* Effect.all(
          [upstreamRefs(rows.map((r) => r.id)), Clock.currentTimeMillis],
          { concurrency: 2 },
        );
        for (const r of rows) out.set(r.id, toInfo(r, refs.get(r.id) ?? null, now));
        return out;
      });

    const store: TokenStore = {
      findByRefs: (input) =>
        Effect.gen(function* () {
          const out = new Map<TokenRef, TokenRefHit>();
          if (input.length === 0) return out;
          // 拆成两段;读不懂的串不进表,直接不返回(调用方按 miss 处理)。
          const pairs: { ref: TokenRef; namer: string; localName: string }[] = [];
          for (const ref of new Set(input)) {
            const p = partsOf(ref);
            if (p) pairs.push({ ref, ...p });
          }
          if (pairs.length === 0) return out;

          const parts = chunk(pairs, REF_PAIR_CHUNK).filter((p) => p.length > 0);
          const batches = yield* Effect.forEach(parts, (part) =>
            client.query((db) =>
              db
                .select({
                  namer: tokenRefs.namer,
                  localName: tokenRefs.localName,
                  tokenId: tokenRefs.tokenId,
                })
                .from(tokenRefs)
                .where(whereRefs(part)),
            ),
          );
          const found = batches.flat().map((r) => ({ ref: formatTokenRef(r), tokenId: r.tokenId }));

          const linked = yield* linkedAmong(found.map((f) => f.tokenId));
          for (const f of found) {
            out.set(f.ref, { tokenId: f.tokenId, linked: linked.has(f.tokenId) });
          }
          return out;
        }),

      // **幂等**:账户并发跑,同一条 ref 会被同时 mint。先插 ref 行(冲突不动)再读回 ——
      // 谁先插谁的 token_id 生效,后来者读到的就是那一个,自己刚建的 tokens 行没人引用、无害。
      create: (seed: ProviderTokenSeed, newRefs) =>
        Effect.gen(function* () {
          const pairs = [...new Set(newRefs)].flatMap((ref) => {
            const p = partsOf(ref);
            return p ? [p] : [];
          });
          const id = crypto.randomUUID();
          const now = yield* Clock.currentTimeMillis;
          yield* client.batch((db) => [
            db.insert(tokens).values({
              id,
              userId,
              symbol: seed.symbol,
              name: seed.name ?? seed.symbol,
              providerLogo: seed.providerLogo ?? null,
              // info TTL 沿用旧列(非空约束);新参考层不按它门控读(见 getByIds 注释)。
              infoExpiresAt: now,
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
          const rows = yield* client.query((db) =>
            db.select({ tokenId: tokenRefs.tokenId }).from(tokenRefs).where(whereRefs(pairs)),
          );
          const winner = rows[0]?.tokenId ?? id;
          // 自己没抢到 → 把刚建的孤行删掉,别在表里留垃圾。
          if (winner !== id) {
            yield* client.query((db) => db.delete(tokens).where(eq(tokens.id, id)));
          }
          return winner;
        }),

      linkRef: (tokenId, ref) =>
        Effect.gen(function* () {
          const p = partsOf(ref);
          if (!p) return tokenId;
          // 「一个 Token 在一个命名者下最多一条 ref」由唯一索引 `(user_id, token_id, namer)` 在 DB 层
          // 兜底(见 schema.ts);这里先在应用层挡一道 —— 已经有那一档了就什么都不做,给个确定的返回值,
          // 不必等约束抛错。约束存在的意义是并发:两个实例同时走到这、都读到「还没有」时,谁插进去谁生效。
          const existing = yield* client.query((db) =>
            db
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
              ),
          );
          // 这条 ref 已有主 → 返回它的主(幂等;可能不是传进来的 tokenId)。
          const owner = existing.find((r) => r.localName === p.localName);
          if (owner) return owner.tokenId;
          // 这个 Token 在该命名者下已有别的叫法 → 不加第二条。
          if (existing.length > 0) return tokenId;
          // 真加了一条 ref → **info 标成该刷**(契约见 `@folio/oracle-basic` 的 stores.ts):某个来源开始用新名字称呼一个
          // 我们已经认识的币,这就是改名的证据。同一批发,省一次往返。
          yield* client.batch((db) => [
            // 无目标 onConflict:两道约束(PK 与 `(user_id, token_id, namer)` 唯一索引)任一撞了都静默。
            // 并发时另一个实例可能已给同一 Token 在同命名者下插了条**不同 local_name** 的 ref —— 那撞的是
            // 唯一索引而非 PK,只认 PK 会抛。输家在此 no-op、返回原 tokenId,收敛到先到者那条。
            db
              .insert(tokenRefs)
              .values({ userId, namer: p.namer, localName: p.localName, tokenId })
              .onConflictDoNothing(),
            expireInfoStmt(db, tokenId),
          ]);
          return tokenId;
        }),

      // 合并:ref 改指 + **历史快照的 token_id 一并改指** + 旧行删除。
      // 身份可变、金额不变 —— 不改历史行的话曲线会在合并那一刻断成两段。
      //
      // `from` 的价随 tokens 行一起消失(价 facet 就在那一行上);**历史日价不用管** ——
      // 它按 tokenRef 全局存,与 token_id 无关,赢家读的就是同一批行,曲线一格都不缺。
      merge: (from, into) =>
        Effect.gen(function* () {
          if (from === into) return;
          // ref 行改指:`into` 已有同一 (namer, local_name) 的话主键会撞 → 先删掉 `from` 那边的重复项。
          const refsOf = (tokenId: string) =>
            client.query((db) =>
              db
                .select({ namer: tokenRefs.namer, localName: tokenRefs.localName })
                .from(tokenRefs)
                .where(and(eq(tokenRefs.userId, userId), eq(tokenRefs.tokenId, tokenId))),
            );
          const [fromRefs, intoRefs] = yield* Effect.all([refsOf(from), refsOf(into)], {
            concurrency: 2,
          });
          // 改指前先剔掉会撞约束的 `from` ref。约束有两道:PK `(user_id, namer, local_name)` 挡
          // 整条重复;唯一索引 `(user_id, token_id, namer)` 挡「同一 Token 一个命名者两条 ref」——
          // 后者意味着 `into` 已有某命名者的 ref 时,`from` 在**同命名者**下的 ref(哪怕 local_name
          // 不同)也不能改指过去。两道都归结为「按命名者去重,留 `into` 那份」:命名者已被 `into`
          // 占了的,`from` 那条一律删。两行会合并本就说明至少一边的名字与上游当前叫法不一致,丢的是
          // 输家那份候选,赢家(`into`,通常是被上游认出的那行)的身份保持不变。
          const taken = new Set(intoRefs.map((r) => r.namer));
          const dupes = fromRefs.filter((r) => taken.has(r.namer));

          yield* client.batch((db) => [
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
            // 两行会合并,正说明至少有一边的名字与上游当前的叫法不一致 —— 赢家留的是自己那份,
            // 可能就是旧的那份。标成该刷,别等 30 天的 TTL。
            expireInfoStmt(db, into),
          ]);
        }),

      // **不门控 info TTL** —— 只要行在就给。门控了会渲染出 logo 代理 URL 却在端点上 404。
      getByIds: readInfos,

      getById: (id) => Effect.map(readInfos([id]), (m) => Option.fromNullable(m.get(id))),

      fillInfo: (tokenId, patch: TokenInfoPatch) =>
        Effect.suspend(() => {
          // 只填空槽:undefined 的字段不动,**已有值的字段也不动**(那可能是上游的好数据)。
          const set: Record<string, unknown> = {};
          if (patch.name !== undefined) {
            set.name = sql`coalesce(nullif(${tokens.name}, ''), ${patch.name})`;
          }
          if (patch.logo !== undefined) set.logo = sql`coalesce(${tokens.logo}, ${patch.logo})`;
          if (patch.providerLogo !== undefined) {
            set.providerLogo = sql`coalesce(${tokens.providerLogo}, ${patch.providerLogo})`;
          }
          if (Object.keys(set).length === 0) return Effect.void;
          return client.query((db) =>
            db
              .update(tokens)
              .set(set)
              .where(and(eq(tokens.userId, userId), eq(tokens.id, tokenId))),
          );
        }),

      // **覆盖**上游那三个字段 + 续 info TTL(与 fillInfo 的填空槽相反,见 `@folio/oracle-basic` 的 stores.ts 契约注释)。
      // `providerLogo` 不动 —— 那是连接器自带的备用图,上游无权覆盖。
      // 逐行一条 UPDATE(每条 5 个参数,远在 D1 的每语句 100 个绑定参数上限内),一批打包发。
      putInfo: (rows, ttlMs) =>
        Effect.gen(function* () {
          if (rows.length === 0) return;
          const expiresAt = (yield* Clock.currentTimeMillis) + ttlMs;
          // 批与批之间顺序发(写路径)。
          yield* Effect.forEach(
            chunk([...rows], INFO_WRITES_PER_BATCH).filter((p) => p.length > 0),
            (part) =>
              client.batch((db) =>
                part.map((r) =>
                  db
                    .update(tokens)
                    .set({
                      symbol: r.symbol,
                      name: r.name,
                      // 上游这次没给图 → 保留原有的,别用 undefined 把它擦成 null。
                      ...(r.logo === undefined ? {} : { logo: r.logo }),
                      infoExpiresAt: expiresAt,
                    })
                    .where(and(eq(tokens.userId, userId), eq(tokens.id, r.tokenId))),
                ),
              ),
            { discard: true },
          );
        }),

      // 「本地已认识的同名币」。服务层的 symbol 消歧主路走 warm blob 筛(见 oracle 的 cache.ts),
      // 这里只是另一条路:本用户已有的、且已被上游认出的同 symbol 币。
      candidatesBySymbol: (symbol) =>
        Effect.map(
          client.query((db) =>
            db
              .select({ localName: tokenRefs.localName, marketCapRank: tokens.marketCapRank })
              .from(tokens)
              .innerJoin(
                tokenRefs,
                and(eq(tokenRefs.tokenId, tokens.id), eq(tokenRefs.namer, namer)),
              )
              .where(and(eq(tokens.userId, userId), eq(tokens.symbol, symbol))),
          ),
          (rows): TokenCandidate[] =>
            rows.map((r) => ({
              ref: formatTokenRef({ namer, localName: r.localName }),
              marketCapRank: r.marketCapRank ?? undefined,
            })),
        ),
    };

    return store;
  });

export const userTokenStoreLayer = (
  opts: UserTokenStoreOpts,
): Layer.Layer<TokenStore, never, DbClient | CurrentUser> => Layer.effect(TokenStore, make(opts));
