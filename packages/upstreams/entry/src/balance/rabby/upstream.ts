import { Duration, Effect, Schema } from "effect";
import { balanceUpstream } from "../../runtime/balance";
import { defineUpstream } from "../../runtime/define";
import { chainIds, protocols, tokens, totalBalance } from "./api";
import { ID, MAX_REQUESTS_PER_SECOND, RABBY_API_BASE, RABBY_API_BASE_OVERRIDE } from "./constants";
import { parseProtocols, parseTokens } from "./parse";

// No API key, but every request is signed (see sign.ts): unsigned is a one-per-40s tier.
const rabby = defineUpstream({
  id: ID,
  label: "Rabby",
  base: RABBY_API_BASE,
  baseOverride: RABBY_API_BASE_OVERRIDE,
  headers: () => ({ accept: "application/json" }),
  limits: {
    default: {
      limit: 1,
      window: Duration.millis(1000 / MAX_REQUESTS_PER_SECOND),
      scope: "deployment",
    },
  },
});

export const rabbyBalance = balanceUpstream(rabby, {
  account: Schema.Struct({ address: Schema.String }),

  // Sequential on purpose: sync already runs ~6 accounts at once. The chain map comes first since
  // both parsers need it.
  fetch: (call, { creds: { address } }) =>
    Effect.all([chainIds(call), tokens(call, address), protocols(call, address)]).pipe(
      Effect.map(([ids, wallet, positions]) => ({
        balances: [...parseTokens(wallet, ids), ...parseProtocols(positions, ids)],
      })),
    ),

  verify: (call, { creds: { address } }) => totalBalance(call, address),
});
