import type { DbRequest, GlobalRefIndexStore, TokenStore } from "@folio/db";
import type { ProviderTokenSeed, TokenCandidate, TokenRef, TokenRefHit } from "@folio/oracle-basic";
import {
  FIAT_NAMER,
  fiatSeed,
  normalizeSymbol,
  RESOLUTION_DOMINANCE,
  RESOLUTION_TOP_RANK,
} from "@folio/oracle-basic";
import type { Namer } from "@folio/oracle-basic/ports";
import {
  tokenRef as buildRef,
  hasTrustedSymbol,
  type ParsedTokenRef,
  parseTokenRef,
} from "@folio/oracle-ref";
import { Effect, Option } from "effect";
import type { CandidateSource } from "./candidates";
// Write path: turns a tokenRef into a `token_id` (`TokenService.mint`). "Which token is this" is fixed here and frozen
// into the snapshot; readers then use token_id directly.
// No network. `MintDeps` has no `*Upstream` and `makeMinting` takes only `MintDeps`, so egress is out of scope by type.
// Red line: this file must not import any `*Upstream` port or `yield* TokenUpstream`; it sits on the user-awaited sync
// path, where a serial upstream round trip would stall the whole batch write.
// Lookup order: local ref rows, then the local global map, then a symbol guess (via `CandidateSource`, which owns the single cold-start egress in its own layer).
export interface TokenMinting {
  // A batch of (ref, provider metadata) to token_ids; duplicate refs in the input are processed once.
  mint(inputs: readonly MintInput[]): Effect.Effect<Map<TokenRef, string>, never, DbRequest>;
}

export interface MintInput {
  ref: TokenRef;
  seed: ProviderTokenSeed;
}

// Everything the mint half needs; no upstream.
export interface MintDeps {
  readonly store: TokenStore;
  // Contract is the `@folio/db` implementation (derived from it).
  readonly globalRefIndex: GlobalRefIndexStore;
  readonly candidates: CandidateSource["Service"];
  // Current upstream's id: ref namer and the global map's `namer` column; `overrides` is its curated symbol to upstream id table (see `Namer`).
  readonly namer: Namer;
}

// Market-cap disambiguation gate: confident if within top-N, a sole candidate, or far ahead of the runner-up; otherwise the
// caller degrades (separate rows, no upstream link). Two rows beat a wrong merge, which would count a fake USDC into the real one.
export function pickByConfidence(candidates: readonly TokenCandidate[]): TokenRef | undefined {
  if (candidates.length === 0) return undefined;

  const rank = (c: TokenCandidate): number => c.marketCapRank ?? Number.POSITIVE_INFINITY;
  const sorted = [...candidates].sort((a, b) => rank(a) - rank(b));
  const best = sorted[0];
  if (sorted.length === 1) return best.ref;

  const bestRank = rank(best);
  const runnerRank = rank(sorted[1]);

  if (bestRank <= RESOLUTION_TOP_RANK) return best.ref;
  // Best has a rank, the rest none: unambiguous
  if (!Number.isFinite(runnerRank) && Number.isFinite(bestRank)) return best.ref;
  if (
    Number.isFinite(runnerRank) &&
    bestRank > 0 &&
    runnerRank / bestRank >= RESOLUTION_DOMINANCE
  ) {
    return best.ref;
  }
  return undefined;
}

// Takes resolved service objects, not from context, so `mint`'s `R` has only `DbRequest`; Tags are read only in `./index`.
export function makeMinting(deps: MintDeps): TokenMinting {
  const { store, globalRefIndex, candidates } = deps;
  const { id: namer, overrides } = deps.namer;

  // What this ref is called at the current upstream. Address beats symbol: a symbol is only a guess, and reordering would merge a fake USDC into the real one.
  const upstreamRefOf = (
    ref: TokenRef,
    parsed: ParsedTokenRef,
    seed: ProviderTokenSeed,
  ): Effect.Effect<Option.Option<TokenRef>, never, DbRequest> =>
    Effect.gen(function* () {
      // The ref is already the upstream's own naming (manual accounts: the user picked a token). It is the anchor: return
      // it without the map lookup (the map holds on-chain addresses only) and without guessing by symbol.
      if (parsed.kind === "issued" && parsed.namer === namer) return Option.some(ref);

      // The global table lookup by address returns the whole upstream ref.
      const found = yield* globalRefIndex.lookup(namer, [ref]);
      const upstreamRef = Option.fromNullishOr(found.get(ref));
      if (Option.isSome(upstreamRef)) return upstreamRef;

      // The symbol tier admits only shapes with a vouching party (`native` / `issued`); see `hasTrustedSymbol`. Contract symbols are
      // deployer-chosen, hand-typed (`custom:`) has no voucher, unreadable is unknown. A miss is silent: a fake contract
      // symbolled `USDC` would merge into real USDC, inflating totals, and the decision is frozen into the snapshot.
      if (!hasTrustedSymbol(parsed)) return Option.none();

      const symbol = normalizeSymbol(seed.symbol);
      const override = overrides[symbol];
      if (override) return Option.some(buildRef.issued(namer, override));
      // Not confident (small tokens sharing a name): `none`, each gets its own row with no upstream link.
      return Option.fromNullishOr(pickByConfidence(yield* candidates.bySymbol(symbol)));
    });

  // Full decision tree for one ref; returns the token_id it ends up with.
  const mintOne = (
    ref: TokenRef,
    seed: ProviderTokenSeed,
    hit: TokenRefHit | undefined,
  ): Effect.Effect<string, never, DbRequest> =>
    Effect.gen(function* () {
      // Already recognised (has a ref row for the current upstream): nothing to do; most rows stop here.
      if (hit?.linked) return hit.tokenId;

      const parsed = parseTokenRef(ref);

      // Fiat is its own branch: self-anchored identity, never upstream lookup or symbol guess (fiat has no upstream price).
      // Must short-circuit before `upstreamRefOf`, or USD cash would be symbol-matched to some token named USD.
      const isFiat = parsed.kind !== "unknown" && parsed.namer === FIAT_NAMER;
      if (isFiat) {
        // Same fiat minted again reuses the canonical row (looked up by `fiat/issued:CODE`); not required for correctness
        // since `store.create` is idempotent by ref, it only avoids creating then deleting an orphan row.
        if (hit) return hit.tokenId;
        // Whitelisted fiat (`SUPPORTED_CURRENCIES`): canonical seed (`symbol=CODE` + inline logo); non-whitelisted (e.g. `fiat/native`)
        // gets a plain row from the provider seed, not anchored to canonical.
        const canonical = parsed.kind === "issued" ? fiatSeed(parsed.id) : undefined;
        return yield* store.create(canonical ?? seed, [ref]);
      }

      const upstreamRef = yield* upstreamRefOf(ref, parsed, seed);

      // Still not recognised.
      if (Option.isNone(upstreamRef)) {
        // Existing row: unchanged (provider ref only); the next sync retries the local lookup and links it.
        if (hit) return hit.tokenId;
        // New row: write only the provider ref; the snapshot is still written, not blocked on upstream.
        return yield* store.create(seed, [ref]);
      }

      const owner = Option.fromNullishOr(
        (yield* store.findByRefs([upstreamRef.value])).get(upstreamRef.value),
      );

      // Recognised.
      if (!hit) {
        // First time seeing this ref. If another chain already has the same token, add just one ref (multi-chain merge happens here);
        // otherwise create the row plus two refs (provider's and upstream's).
        if (Option.isSome(owner)) {
          // Merge into the existing token: do not overwrite its metadata (possibly good upstream data), only fill empty slots.
          yield* store.fillInfo(owner.value.tokenId, {
            name: seed.name,
            providerLogo: seed.providerLogo,
          });
          return yield* store.linkRef(owner.value.tokenId, ref);
        }
        // Dedupe: when the ref is itself the upstream's naming the two are equal, and ref rows are keyed (namer, localName), so
        // inserting both would hit the primary key and fail the batch.
        return yield* store.create(seed, [...new Set([ref, upstreamRef.value])]);
      }

      // Recognised after the fact: merge.
      // The global map lacked it last time, so a row with only the provider ref was created; the local table now recognises it.
      if (Option.isSome(owner) && owner.value.tokenId !== hit.tokenId) {
        // Another row already holds this token: merge the old row in (repoint refs and historical snapshots' token_id, delete old row);
        // otherwise the curve would split in two at the merge.
        yield* store.merge(hit.tokenId, owner.value.tokenId);
        return owner.value.tokenId;
      }
      // Nobody holds it: add the upstream ref in place; the row (history, logo) stays.
      yield* store.linkRef(hit.tokenId, upstreamRef.value);
      return hit.tokenId;
    });

  return {
    mint: (inputs) =>
      Effect.gen(function* () {
        const out = new Map<TokenRef, string>();
        if (inputs.length === 0) return out;

        // Duplicate refs in a batch are processed once (one wallet often holds a token several times).
        const byRef = new Map<TokenRef, ProviderTokenSeed>();
        for (const i of inputs) if (!byRef.has(i.ref)) byRef.set(i.ref, i.seed);

        // Step 1: one batched lookup of local ref rows; most syncs stop here, purely local.
        const hits = yield* store.findByRefs([...byRef.keys()]);

        // Walk the decision tree one by one, sequentially. Accounts run concurrently so one ref can be minted twice at once,
        // converging through the store's upsert-then-read idempotency (`TokenStore.create`).
        for (const [ref, seed] of byRef) {
          const hit = hits.get(ref);
          // Rows already recognised are taken on the spot (same criterion as `mintOne`'s first line) without a `Effect.gen` per row,
          // which is not free within the 10ms budget at dozens of rows per sync.
          out.set(ref, hit?.linked ? hit.tokenId : yield* mintOne(ref, seed, hit));
        }
        return out;
      }),
  };
}
