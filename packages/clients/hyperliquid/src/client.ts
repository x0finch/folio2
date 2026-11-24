import { makeRequester, type Outbound } from "@folio/client-core";
import type { UpstreamError } from "@folio/upstream-basic";
import { Context, Effect, Layer } from "effect";
import { CLEARINGHOUSE_TYPE, HYPERLIQUID_API_BASE, INFO_PATH, UPSTREAM } from "./constants";
import { ClearinghouseState } from "./types";

export interface HyperliquidConfig {
  // Base URL, used as one opaque string; defaults to the official endpoint. Proxy override exists for exchanges blocked by region (binance /
  // bybit / okx); hyperliquid has no such need, but the knob keeps the clients' shape uniform and gives tests isolation.
  readonly apiBase?: string;
}

// Request layer for Hyperliquid REST: methods follow upstream endpoints and return upstream shapes (DTOs); `parseClearinghouseState`, the
// perp valuation model and `tokenRef` naming stay in the adapter. One endpoint, `POST /info`, with the question given by `type` in the body,
// so one method per question (do not leak `type` to callers, which would make them assemble hyperliquid's protocol).
// No gate (see constants.ts) and no retry of its own (retry belongs to sync).

export interface HyperliquidClientApi {
  // Perp account state: margin summary + positions. The address is an EVM address passed per call, so one client serves many accounts.
  readonly clearinghouseState: (
    address: string,
  ) => Effect.Effect<ClearinghouseState, UpstreamError, Outbound>;
}

export class HyperliquidClient extends Context.Service<HyperliquidClient, HyperliquidClientApi>()(
  "clients/Hyperliquid",
) {
  static readonly layer = (config: HyperliquidConfig = {}): Layer.Layer<HyperliquidClient> =>
    Layer.sync(HyperliquidClient, () => make(config));
}

// Not an Effect, unlike binance (whose `yield* makeRateLimit` needs a `Scope`): with no gate, construction is pure.
export function make(config: HyperliquidConfig = {}): HyperliquidClientApi {
  const request = makeRequester({
    baseUrl: config.apiBase ?? HYPERLIQUID_API_BASE,
    upstream: UPSTREAM,
    // Fixed headers go in `headers`, not each call's `init`: they belong to the upstream, not to one request.
    // `content-type` must be application/json or hyperliquid answers 422.
    headers: () =>
      Effect.succeed({ "content-type": "application/json", accept: "application/json" }),
  });

  return {
    clearinghouseState: (address) =>
      request(INFO_PATH, ClearinghouseState, {
        method: "POST",
        body: JSON.stringify({ type: CLEARINGHOUSE_TYPE, user: address }),
      }),
  };
}
