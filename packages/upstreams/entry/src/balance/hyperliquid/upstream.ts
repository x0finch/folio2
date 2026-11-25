import { Effect, Schema } from "effect";
import { balanceUpstream } from "../../runtime/balance";
import { defineUpstream } from "../../runtime/define";
import { clearinghouseState } from "./api";
import { HYPERLIQUID_API_BASE, HYPERLIQUID_API_BASE_OVERRIDE, ID } from "./constants";
import { parseClearinghouseState } from "./parse";

const hyperliquid = defineUpstream({
  id: ID,
  label: "Hyperliquid",
  base: HYPERLIQUID_API_BASE,
  baseOverride: HYPERLIQUID_API_BASE_OVERRIDE,
  // Without application/json hyperliquid answers 422.
  headers: () => ({ "content-type": "application/json", accept: "application/json" }),
});

// A never-traded address answers 200 with an empty state, so `fetch` doubles as `verify`.
export const hyperliquidBalance = balanceUpstream(hyperliquid, {
  account: Schema.Struct({ address: Schema.String }),
  fetch: (call, { creds }) =>
    clearinghouseState(call, creds.address).pipe(
      Effect.map((state) => ({ balances: parseClearinghouseState(state) })),
    ),
});
