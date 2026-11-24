import type { Outbound } from "@folio/client-core";
import type { CoinGeckoClient } from "@folio/coingecko-client";
import { SUPPORTED_CURRENCIES } from "@folio/oracle-basic";
import { tokenRef } from "@folio/oracle-ref";
import { type UpstreamError, UpstreamParseError } from "@folio/upstream-basic";
import { FxUpstream } from "@folio/upstream-basic/ports";
import { Effect, Layer } from "effect";
import { BTC_COIN_ID, UPSTREAM_ID } from "./constants";
import { closeOver, type Needs } from "./layer";
import { req, withClient } from "./runtime";

const EXCHANGE_RATES_PATH = "/exchange_rates";

// CoinGecko `FxUpstream`. `/exchange_rates` is quoted against BTC (value = how much of the currency 1 BTC is worth),
// so usdPerUnit(X) = rates.usd.value / rates.X.value. Only the whitelisted currencies are derived.
export const fetchRatesEffect: Effect.Effect<
  Map<string, number>,
  UpstreamError,
  CoinGeckoClient | Outbound
> = withClient((client) =>
  Effect.flatMap(req(client.exchangeRates), (res) => {
    const rates = res.rates ?? {};
    const usdPerBtc = rates.usd?.value;
    // Missing base means a broken response (parse error, not retryable), not an unlisted currency.
    if (typeof usdPerBtc !== "number" || usdPerBtc <= 0) {
      return Effect.fail(
        new UpstreamParseError({
          upstream: UPSTREAM_ID,
          where: EXCHANGE_RATES_PATH,
          cause: "missing/invalid usd rate",
        }),
      );
    }
    const out = new Map<string, number>();
    for (const { code } of SUPPORTED_CURRENCIES) {
      if (code === "USD") {
        out.set("USD", 1);
        continue;
      }
      // Upstream keys are lowercase; unknown currencies are simply absent from the result.
      const perBtc = rates[code.toLowerCase()]?.value;
      if (typeof perBtc === "number" && perBtc > 0) out.set(code, usdPerBtc / perBtc);
    }
    return Effect.succeed(out);
  }),
);

const make = Effect.map(
  closeOver,
  (close): FxUpstream => ({
    id: UPSTREAM_ID,

    // BTC base of the derivation and cache key of the BTC/USD history leg: the same ref the token adapter
    // produces, so it shares the global rows written by `tokens.priceSeries`.
    btcRef: tokenRef.issued(UPSTREAM_ID, BTC_COIN_ID),

    fetchRates: () => close(fetchRatesEffect),
  }),
);

/** Mounted on a given transport; the only export path is `coinGeckoUpstreamLayers`. */
export const fxUpstreamOn = (t: Layer.Layer<Needs>): Layer.Layer<FxUpstream> =>
  Layer.provide(Layer.effect(FxUpstream, make), t);
