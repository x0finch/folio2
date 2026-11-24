import type { Balance } from "@folio/connectors-basic";
import type { DbRequest } from "@folio/db";
import { Oracle } from "@folio/oracle";
import { fiatCodeOf, type ValuationMode, valuate } from "@folio/oracle-basic";
import { Effect, Option } from "effect";

// Values balances before a snapshot is written.
// - Non-mark-to-market kinds capture a selfPrice (price ?? value/amount); mark-to-market never do.
// - `mode` picks self-first (default) or source-first; with neither price the provider value stays.
// - Source prices come from one batched read of the price table, never upstream: per-holding
//   fetches blew the 50-subrequest budget. The table may be an hour old; display re-prices anyway.
// - Identity comes from `idByRef` (minted in the previous step), not resolved again here.
// - Fiat (`fiat/issued:<CODE>`) is amount × fx rate, recomputed each time; no rate → keep value.
export const revalue = (
  markToMarket: boolean,
  balances: Balance[],
  idByRef: ReadonlyMap<string, string>,
  mode: ValuationMode = "self-first",
): Effect.Effect<Balance[], never, Oracle | DbRequest> =>
  Effect.gen(function* () {
    const { tokens, fx } = yield* Oracle;

    // A reported price of 0 means the exchange doesn't know it, not that it's worthless; treating
    // it as a self price would pin the token at $0 under self-first.
    const selfPriceOf = (b: Balance): number | undefined =>
      markToMarket
        ? undefined
        : b.price != null && b.price > 0
          ? b.price
          : b.amount > 0 && b.value > 0
            ? b.value / b.amount
            : undefined;
    // Unrecognised tokens have no id, so no source price; don't guess.
    const sourceIdOf = (b: Balance): string | undefined => {
      if (b.kind === "perp_position" || b.kind === "perp_equity") return undefined;
      if (b.tokenRef && fiatCodeOf(b.tokenRef)) return undefined;
      if (mode !== "source-first" && selfPriceOf(b) != null) return undefined;
      return b.tokenRef ? idByRef.get(b.tokenRef) : undefined;
    };

    const wanted = [...new Set(balances.map(sourceIdOf).filter((id) => id !== undefined))];
    const sourcePrices = yield* tokens.pricesOf(wanted);

    return yield* Effect.forEach(
      balances,
      (b) =>
        Effect.gen(function* () {
          // Perp values aren't amount × price: repricing would turn positions into huge notionals.
          // Keep the provider values.
          if (b.kind === "perp_position" || b.kind === "perp_equity") return b;

          const fiatCode = b.tokenRef ? fiatCodeOf(b.tokenRef) : undefined;
          if (fiatCode) {
            const usdPerUnit = yield* fx.resolve(fiatCode);
            if (Option.isNone(usdPerUnit)) return b;
            return {
              ...b,
              price: usdPerUnit.value,
              value: b.amount * usdPerUnit.value,
            };
          }

          const selfPrice = selfPriceOf(b);
          const sourceId = sourceIdOf(b);
          const sourcePrice = sourceId ? sourcePrices.get(sourceId)?.unitPrice : undefined;
          const v = valuate(b.amount, selfPrice, sourcePrice, mode);
          return v ? { ...b, selfPrice, price: v.unitPrice, value: v.value } : { ...b, selfPrice };
        }),
      { concurrency: "unbounded" },
    );
  });
