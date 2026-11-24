import type { DbRequest, TokenPriceStore, TokenStore } from "@folio/db";
import { INFO_TTL_MS, normalizeSymbol, PRICE_TTL_MS } from "@folio/oracle-basic";
import type { TokenUpstream } from "@folio/upstream-basic/ports";
import { Effect } from "effect";
import { logDegraded } from "./swr";

// Background refresh: the only slice that overwrites existing rows (price and metadata each have an upstream endpoint).
// Only stale ones are refreshed; staleness comes from the two stores (`stale`, `infoStale`), this slice computes no TTL.
export interface TokenStaleRefresh {
  // Background warm: for this batch, tokens whose price / metadata is stale or missing each get one batched fetch and write-back.
  // One method, not two: call sites call them in pairs and each would read `store.getByIds(ids)`; combined, the reads happen once
  // and the price and info branches run concurrently. They remain two upstream endpoints with two TTLs (info ~30d, price 30min).
  // `degraded` means an upstream failed this round (not "nothing to refresh"); `E` stays `never`, so callers need not catch.
  refreshStale(ids: readonly string[]): Effect.Effect<RefreshStaleReport, never, DbRequest>;
}

export interface RefreshStaleReport {
  // Counts of prices / metadata rows written back.
  prices: number;
  infos: number;
  // Whether an upstream failure made this round refresh less; distinct from "nothing to refresh".
  degraded: boolean;
}

export const makeStaleRefresh = (
  store: TokenStore,
  prices: TokenPriceStore,
  upstream: TokenUpstream,
): TokenStaleRefresh => {
  // Prices for a batch of (ref to tokenId): fetch, write back; returns rows written and whether it degraded.
  const refreshPrices = (
    byRef: Map<string, string>,
  ): Effect.Effect<{ written: number; degraded: boolean }, never, DbRequest> =>
    Effect.gen(function* () {
      if (byRef.size === 0) return { written: 0, degraded: false };
      const fetched = yield* Effect.result(upstream.fetchPrices([...byRef.keys()]));
      if (fetched._tag === "Failure") {
        yield* logDegraded("tokens.refreshStale.prices", fetched.failure);
        return { written: 0, degraded: true };
      }
      const writes = [...fetched.success.entries()]
        .map(([ref, price]) => {
          const tokenId = byRef.get(ref);
          // Drop refs upstream returned that we did not ask for (or that were merged away); never write stray rows.
          return tokenId ? { tokenId, ...price } : undefined;
        })
        .filter((w) => w !== undefined);
      if (writes.length > 0) yield* prices.put(writes, PRICE_TTL_MS);
      return { written: writes.length, degraded: false };
    });

  // Metadata for a batch of (ref to tokenId): fetch, then overwrite (upstream is the authority for these three fields).
  // Overwrite rather than fill empty slots: the row was built from connector metadata and on-chain contract symbols are
  // deployer strings (MATIC stays MATIC after the rename to POL); the contract ref was recognised by address and is trusted,
  // only the display name is stale, and the name must not depend on which account syncs first.
  const refreshInfos = (
    byRef: Map<string, string>,
  ): Effect.Effect<{ written: number; degraded: boolean }, never, DbRequest> =>
    Effect.gen(function* () {
      if (byRef.size === 0) return { written: 0, degraded: false };
      const fetched = yield* Effect.result(upstream.fetchTokens([...byRef.keys()]));
      if (fetched._tag === "Failure") {
        yield* logDegraded("tokens.refreshStale.infos", fetched.failure);
        return { written: 0, degraded: true };
      }
      const writes = fetched.success
        .map((t) => {
          const tokenId = byRef.get(t.ref);
          // Refs upstream did not list are absent; ones that came back but match no requested key are dropped.
          // Normalise symbol case: uppercase is our display convention while CoinGecko gives lowercase (`usdc`);
          // unnormalised, a refresh would flip a row from `USDC` to `usdc`, and symbol is also the disambiguation key.
          // Overwriting the upstream name is right (MATIC to POL); case is not content.
          return tokenId
            ? { tokenId, symbol: normalizeSymbol(t.symbol), name: t.name, logo: t.logo }
            : undefined;
        })
        .filter((w) => w !== undefined);
      if (writes.length > 0) yield* store.putInfo(writes, INFO_TTL_MS);
      return { written: writes.length, degraded: false };
    });

  return {
    refreshStale: (ids) =>
      Effect.gen(function* () {
        if (ids.length === 0) return { prices: 0, infos: 0, degraded: false };
        // Two reads, not four: the price and info halves share them.
        const [infos, priced] = yield* Effect.all([store.getByIds(ids), prices.getByIds(ids)], {
          concurrency: 2,
        });

        // Only tokens that are recognised and whose price is stale or missing.
        const priceTargets = new Map<string, string>();
        for (const [id, info] of infos) {
          const p = priced.get(id);
          if (p && !p.stale) continue;
          if (info.ref) priceTargets.set(info.ref, id);
        }

        // Metadata only for recognised rows (non-empty ref) with stale info: unrecognised rows have no upstream name, so the connector's is right.
        const infoTargets = new Map<string, string>();
        for (const [id, info] of infos) {
          if (!info.infoStale || !info.ref) continue;
          infoTargets.set(info.ref, id);
        }

        // The two branches run concurrently, each failing independently: `Effect.result` rather than `degradeTo` because
        // the failure must also reach the caller (`RefreshStaleReport.degraded`).
        const [priceOutcome, infoOutcome] = yield* Effect.all(
          [refreshPrices(priceTargets), refreshInfos(infoTargets)],
          { concurrency: 2 },
        );
        return {
          prices: priceOutcome.written,
          infos: infoOutcome.written,
          degraded: priceOutcome.degraded || infoOutcome.degraded,
        };
      }),
  };
};
