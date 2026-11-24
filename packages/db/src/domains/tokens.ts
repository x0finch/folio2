import type {
  ProviderTokenSeed,
  TokenCandidate,
  TokenInfo,
  TokenInfoPatch,
  TokenInfoWrite,
  TokenRef,
  TokenRefHit,
} from "@folio/oracle-basic";
import { formatTokenRef, parseTokenRef } from "@folio/oracle-ref";
import { and, eq, exists, inArray, or, sql } from "drizzle-orm";
import { Clock, Effect, Option } from "effect";
import { chunk, type DbClient } from "../client";
import type { Drizzle } from "../connect";
import { accounts, snapshotBalances, snapshots, tokenRefs, tokens } from "../schema";

// Writes `tokens` (info facet, with user_id) and `token_refs` (this user's names per namer).
//
// `namer` only answers "did the upstream recognise this Token", i.e. a ref row at that namer exists.

// D1 caps ~100 bound parameters per statement: a ref lookup takes 2 plus 1 for user_id, so batches of 40 (81) stay under.
const REF_PAIR_CHUNK = 40;

// One UPDATE per row; the real limit is statements per batch. A refresh is the user's on-screen holdings (tens to hundreds), so 50 per batch.
const INFO_WRITES_PER_BATCH = 50;

// tokenRef <-> two columns is split/built by @folio/oracle-ref; this file never knows the right-hand grammar. Unparseable strings are skipped on read and write.
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

export const makeUserTokenStore = (namer: string) => (client: DbClient, userId: string) => {
  // One batch's where: (namer=? AND local_name=?) OR ...; all rows are this user's, so user_id once.
  const whereRefs = (pairs: { namer: string; localName: string }[]) =>
    and(
      eq(tokenRefs.userId, userId),
      or(
        ...pairs.map((p) =>
          and(eq(tokenRefs.namer, p.namer), eq(tokenRefs.localName, p.localName)),
        ),
      ),
    );

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
      // A Token should have one row per namer (see linkRef); pick deterministically if there are two.
      for (const rows of batches) {
        for (const r of rows) {
          if (!out.has(r.tokenId)) {
            out.set(r.tokenId, formatTokenRef({ namer, localName: r.localName }));
          }
        }
      }
      return out;
    });

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
    // Expired rows are still returned, only flagged for refresh (see getByIds).
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
      const [refs, now] = yield* Effect.all(
        [upstreamRefs(rows.map((r) => r.id)), Clock.currentTimeMillis],
        { concurrency: 2 },
      );
      for (const r of rows) out.set(r.id, toInfo(r, refs.get(r.id) ?? null, now));
      return out;
    });

  // Info for all of this user's Tokens: two queries filtered by user_id (+ namer), no id chunking.
  const readAllInfos = (): Effect.Effect<Map<string, TokenInfo>> =>
    Effect.gen(function* () {
      const [rows, refRows, now] = yield* Effect.all(
        [
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
                .where(eq(tokens.userId, userId)),
          ),
          client.query((db) =>
            db
              .select({ tokenId: tokenRefs.tokenId, localName: tokenRefs.localName })
              .from(tokenRefs)
              .where(and(eq(tokenRefs.userId, userId), eq(tokenRefs.namer, namer))),
          ),
          Clock.currentTimeMillis,
        ],
        { concurrency: 3 },
      );
      const refs = new Map<string, TokenRef>();
      // Same as `upstreamRefs`: take the first row if a namer has two.
      for (const r of refRows) {
        if (!refs.has(r.tokenId))
          refs.set(r.tokenId, formatTokenRef({ namer, localName: r.localName }));
      }
      const out = new Map<string, TokenInfo>();
      for (const r of rows) out.set(r.id, toInfo(r, refs.get(r.id) ?? null, now));
      return out;
    });

  return {
    findByRefs: (input: readonly TokenRef[]): Effect.Effect<Map<TokenRef, TokenRefHit>> =>
      Effect.gen(function* () {
        const out = new Map<TokenRef, TokenRefHit>();
        if (input.length === 0) return out;
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

    // Idempotent: concurrent accounts can mint the same ref, so upsert-then-read and return the winning id (maybe not the one just created).
    create: (seed: ProviderTokenSeed, newRefs: readonly TokenRef[]): Effect.Effect<string> =>
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
            // info TTL keeps the old column (NOT NULL); reads aren't gated on it (see getByIds).
            infoExpiresAt: now,
          }),
          ...pairs.map((p) =>
            db
              .insert(tokenRefs)
              .values({ userId, namer: p.namer, localName: p.localName, tokenId: id })
              // PK conflict: someone already created this token; keep theirs, ours becomes an unreferenced orphan.
              .onConflictDoNothing({
                target: [tokenRefs.userId, tokenRefs.namer, tokenRefs.localName],
              }),
          ),
        ]);
        if (pairs.length === 0) return id;
        const rows = yield* client.query((db) =>
          db.select({ tokenId: tokenRefs.tokenId }).from(tokenRefs).where(whereRefs(pairs)),
        );
        const winner = rows[0]?.tokenId ?? id;
        // Lost the race: delete our orphan row.
        if (winner !== id) {
          yield* client.query((db) => db.delete(tokens).where(eq(tokens.id, id)));
        }
        return winner;
      }),

    // Adds a ref to an existing Token (multi-chain merge); no-op if present. A real add marks info stale: sources renaming a coin (MATIC to POL) arrive at different times, and waiting for the 30d TTL would show the old name that long.
    linkRef: (tokenId: string, ref: TokenRef): Effect.Effect<string> =>
      Effect.gen(function* () {
        const p = partsOf(ref);
        if (!p) return tokenId;
        // The unique index `(user_id, token_id, namer)` enforces one ref per namer under concurrency; check here first so the common path returns a definite value without a thrown constraint error.
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
        const owner = existing.find((r) => r.localName === p.localName);
        if (owner) return owner.tokenId;
        if (existing.length > 0) return tokenId;
        // A real add means a source renamed a coin we know: mark info stale in the same batch.
        yield* client.batch((db) => [
          // No conflict target: either constraint (PK or the unique index) silently no-ops; a concurrent insert with a different local_name hits the unique index, not the PK.
          db
            .insert(tokenRefs)
            .values({ userId, namer: p.namer, localName: p.localName, tokenId })
            .onConflictDoNothing(),
          expireInfoStmt(db, tokenId),
        ]);
        return tokenId;
      }),

    // Merge `from` into `into`: re-point refs and historical snapshot token_id, delete the old row. Identity changes, amounts don't, so the history curve stays continuous.
    //
    // `from`'s price goes with its row; daily prices are keyed globally by tokenRef, so the curve is unaffected.
    // The winner's info is marked stale: a merge implies a name differs from the upstream's current one.
    merge: (from: string, into: string): Effect.Effect<void> =>
      Effect.gen(function* () {
        if (from === into) return;
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
        // Drop `from` refs that would collide before re-pointing: dedupe per namer (PK and the `(user_id, token_id, namer)` unique index), keeping `into`'s.
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
          // snapshot_balances has no user_id: scope via snapshot -> account so a foreign token id can't rewrite another user's history.
          db
            .update(snapshotBalances)
            .set({ tokenId: into })
            .where(
              and(
                eq(snapshotBalances.tokenId, from),
                exists(
                  db
                    .select({ one: sql`1` })
                    .from(snapshots)
                    .innerJoin(accounts, eq(accounts.id, snapshots.accountId))
                    .where(
                      and(
                        eq(snapshots.id, snapshotBalances.snapshotId),
                        eq(accounts.userId, userId),
                      ),
                    ),
                ),
              ),
            ),
          // The old row's provider logo is a display fallback; carry it over (fill empty slot only), scoped by user on read and write.
          db
            .update(tokens)
            .set({
              providerLogo: sql`coalesce(${tokens.providerLogo}, (select provider_logo from ${tokens} where id = ${from} and user_id = ${userId}))`,
            })
            .where(and(eq(tokens.userId, userId), eq(tokens.id, into))),
          db.delete(tokens).where(and(eq(tokens.userId, userId), eq(tokens.id, from))),
          expireInfoStmt(db, into),
        ]);
      }),

    // Not gated on info TTL: gating would render a logo proxy URL that 404s.
    getByIds: readInfos,

    getAll: readAllInfos,

    // Returns `Option`: callers must branch on "no such row".
    getById: (id: string): Effect.Effect<Option.Option<TokenInfo>> =>
      Effect.map(readInfos([id]), (m) => Option.fromNullable(m.get(id))),

    // Fill empty slots only; connector-reported info must not overwrite upstream data.
    fillInfo: (tokenId: string, patch: TokenInfoPatch): Effect.Effect<void> =>
      Effect.suspend(() => {
        // Fields that are undefined or already set are left alone.
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

    // Overwrites the three upstream fields and renews the info TTL (unlike fillInfo); `providerLogo` is left alone as the connector's fallback image.
    // Upstream wins here: an on-chain symbol may differ from the upstream's name (MATIC to POL). Only for recognised rows (ref non-null).
    putInfo: (rows: readonly TokenInfoWrite[], ttlMs: number): Effect.Effect<void> =>
      Effect.gen(function* () {
        if (rows.length === 0) return;
        const expiresAt = (yield* Clock.currentTimeMillis) + ttlMs;
        // Batches run sequentially (write path).
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
                    // Keep the existing logo when upstream gave none, rather than nulling it with undefined.
                    ...(r.logo === undefined ? {} : { logo: r.logo }),
                    infoExpiresAt: expiresAt,
                  })
                  .where(and(eq(tokens.userId, userId), eq(tokens.id, r.tokenId))),
              ),
            ),
          { discard: true },
        );
      }),

    // Same-symbol coins this user already has that upstream recognised (the main disambiguation path is the warm-blob filter in oracle cache.ts).
    candidatesBySymbol: (symbol: string): Effect.Effect<TokenCandidate[]> =>
      Effect.map(
        client.query((db) =>
          db
            .select({ localName: tokenRefs.localName, marketCapRank: tokens.marketCapRank })
            .from(tokens)
            .innerJoin(tokenRefs, and(eq(tokenRefs.tokenId, tokens.id), eq(tokenRefs.namer, namer)))
            .where(and(eq(tokens.userId, userId), eq(tokens.symbol, symbol))),
        ),
        (rows): TokenCandidate[] =>
          rows.map((r) => ({
            ref: formatTokenRef({ namer, localName: r.localName }),
            marketCapRank: r.marketCapRank ?? undefined,
          })),
      ),
  };
};
