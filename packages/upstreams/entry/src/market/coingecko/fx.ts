import { SUPPORTED_CURRENCIES } from "@folio/oracle-basic";
import { tokenRef } from "@folio/oracle-ref";
import { type UpstreamError, UpstreamParseError } from "@folio/upstream-basic";
import { FxUpstream } from "@folio/upstream-basic/ports";
import { Effect, Layer } from "effect";
import { exchangeRates } from "./api";
import { BTC_COIN_ID, EXCHANGE_RATES_PATH, ID } from "./constants";
import { closeOver, type Needs, req, withCall } from "./upstream";

// `/exchange_rates` is quoted against BTC, so usdPerUnit(X) = rates.usd.value / rates.X.value.
export const fetchRatesEffect: Effect.Effect<Map<string, number>, UpstreamError, Needs> = withCall(
  (call) =>
    Effect.flatMap(req(exchangeRates(call)), (res) => {
      const rates = res.rates ?? {};
      const usdPerBtc = rates.usd?.value;
      // A missing base is a broken response (not retryable), not an unlisted currency.
      if (typeof usdPerBtc !== "number" || usdPerBtc <= 0) {
        return Effect.fail(
          new UpstreamParseError({
            upstream: ID,
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
        const perBtc = rates[code.toLowerCase()]?.value;
        if (typeof perBtc === "number" && perBtc > 0) out.set(code, usdPerBtc / perBtc);
      }
      return Effect.succeed(out);
    }),
);

const make = Effect.map(
  closeOver,
  (close): FxUpstream => ({
    id: ID,
    // The same ref the token side produces, so the BTC/USD history leg shares its global rows.
    btcRef: tokenRef.issued(ID, BTC_COIN_ID),
    fetchRates: () => close(fetchRatesEffect),
  }),
);

export const fxUpstreamOn = (transport: Layer.Layer<Needs>): Layer.Layer<FxUpstream> =>
  Layer.provide(Layer.effect(FxUpstream, make), transport);
