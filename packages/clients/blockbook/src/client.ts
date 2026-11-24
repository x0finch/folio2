import { type UpstreamError, UpstreamUnavailableError } from "@folio/upstream-basic";
import { makeRequester, type Outbound, type Requester } from "@folio/upstreams";
import { Context, Effect, Layer, type Schema } from "effect";
import {
  BLOCKBOOK_BASES,
  DEFAULT_XPUB_DETAILS,
  DEFAULT_XPUB_TOKENS,
  UPSTREAM,
  USER_AGENT,
  XPUB_SUMMARY_DETAILS,
} from "./constants";
import { AddressResponse, XpubResponse, XpubSummary } from "./types";

export interface BlockbookConfig {
  // Override the endpoint list (tests / self-hosted node); defaults to the built-in btc2-btc5.
  readonly bases?: readonly string[];
  readonly userAgent?: string;
}

// `basic` is not here: that tier returns a different shape (no `unconfirmedBalance`), see `xpubSummary`.
export interface XpubQuery {
  readonly details?: "tokens" | "tokenBalances";
  readonly tokens?: "nonzero" | "used" | "derived";
}

// Request layer for Trezor Blockbook v2 (read-only). Methods follow upstream endpoints and return upstream shapes (DTOs);
// satoshi-string conversion, UTXO totals and `tokenRef` naming belong to the adapter. No credentials (public nodes), so no creds param.
export interface BlockbookClientApi {
  // Balance + per-address for an xpub / descriptor (server-side derivation, replacing per-address gap scanning).
  readonly xpub: (
    token: string,
    query?: XpubQuery,
  ) => Effect.Effect<XpubResponse, UpstreamError, Outbound>;
  // Account summary only (`details=basic`): a liveness probe that skips per-address detail.
  readonly xpubSummary: (token: string) => Effect.Effect<XpubSummary, UpstreamError, Outbound>;
  // Single-address balance.
  readonly address: (address: string) => Effect.Effect<AddressResponse, UpstreamError, Outbound>;
}

export class BlockbookClient extends Context.Service<BlockbookClient, BlockbookClientApi>()(
  "clients/Blockbook",
) {
  static readonly layer = (config: BlockbookConfig = {}): Layer.Layer<BlockbookClient> =>
    Layer.sync(BlockbookClient, () => make(config));
}

// Rotation start, module-level to spread load so not every sync starts from btc2. Deliberately not in a `Scope`: on CF Workers each
// request runs one `runPromise`, so a scope would restart from 0 every time (same reason as the slot cursor).
let cursor = 0;

// Whether an error should move on to the next node. The criterion is blockbook's own, not generic retryability: is it this node or the request?
//   rate-limited by this node / node unreachable (network, 5xx): switch; invalid xpub (4xx): do not (four nodes give the same 4xx);
//   credentials rejected / unreadable response: do not.
// Another node may answer a rate limit or an outage; a refused request (bad xpub) fails the same everywhere.
const shouldTryNextBase = (error: UpstreamError): boolean =>
  error._tag === "UpstreamRateLimitError" || error._tag === "UpstreamUnavailableError";

export function make(config: BlockbookConfig = {}): BlockbookClientApi {
  const bases = config.bases?.length ? config.bases : BLOCKBOOK_BASES;
  const userAgent = config.userAgent ?? USER_AGENT;

  // One requester per base, built once (`make` runs per account per sync; do not rebuild four each time).
  const requesters: Requester[] = bases.map((baseUrl) =>
    makeRequester({
      baseUrl,
      upstream: UPSTREAM,
      // The UA must be sent, see constants.ts.
      headers: () => Effect.succeed({ "user-agent": userAgent, accept: "application/json" }),
    }),
  );

  // Tries nodes in turn until success or an error where switching is pointless. This is blockbook's retry: a "which node" policy,
  // not "how to send one request", so it stays here rather than in `Effect.retry` (both together would multiply latency).
  // Recursion rather than `Effect.firstSuccessOf`, which keeps trying after any failure, while some errors must stop at once.
  const tryBases = <A, I>(
    path: string,
    schema: Schema.Codec<A, I>,
    query: Record<string, string> | undefined,
    from: number,
    left: number,
  ): Effect.Effect<A, UpstreamError, Outbound> =>
    Effect.suspend(() => {
      const at = requesters[from % requesters.length];
      return at(path, schema, { query }).pipe(
        Effect.catch((error) =>
          left > 1 && shouldTryNextBase(error)
            ? tryBases(path, schema, query, from + 1, left - 1)
            : Effect.fail(error),
        ),
      );
    });

  const request = <A, I>(
    path: string,
    schema: Schema.Codec<A, I>,
    query?: Record<string, string>,
  ): Effect.Effect<A, UpstreamError, Outbound> =>
    Effect.suspend(() => {
      if (requesters.length === 0) {
        return Effect.fail(
          new UpstreamUnavailableError({
            upstream: UPSTREAM,
            where: path,
            cause: "no blockbook endpoints configured",
          }),
        );
      }
      // The start advances one slot each time, so the four nodes take turns being first.
      return tryBases(path, schema, query, cursor++, requesters.length);
    });

  // `encodeURIComponent` does not encode parentheses, but a descriptor's (e.g. `tr(xpub…)`) are safer encoded in the path.
  const encodePath = (s: string): string =>
    encodeURIComponent(s).replace(/\(/g, "%28").replace(/\)/g, "%29");

  // `details` / `tokens` go in the query, not welded into the path: `makeRequester` owns that, and the failure `where` carries the query too.
  // But the xpub itself is in the pathname, so it always reaches `where` (Blockbook's URL shape is `/xpub/{token}`). An xpub is `public` here
  // (stored in plain text), so that is acceptable, but it is the whole wallet's watch key: do not copy it into logs again.
  return {
    xpub: (token, query) =>
      request(`/xpub/${encodePath(token)}`, XpubResponse, {
        details: query?.details ?? DEFAULT_XPUB_DETAILS,
        tokens: query?.tokens ?? DEFAULT_XPUB_TOKENS,
      }),

    xpubSummary: (token) =>
      request(`/xpub/${encodePath(token)}`, XpubSummary, { details: XPUB_SUMMARY_DETAILS }),

    address: (address) => request(`/address/${encodePath(address)}`, AddressResponse),
  };
}
