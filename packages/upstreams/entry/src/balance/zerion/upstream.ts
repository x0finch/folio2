import { Duration, Effect, Schema } from "effect";
import { balanceUpstream } from "../../runtime/balance";
import { defineUpstream } from "../../runtime/define";
import { chainIds, portfolio, positions } from "./api";
import {
  ID,
  RATE_LIMIT_BURST,
  RATE_LIMIT_PER_SEC,
  ZERION_API_BASE,
  ZERION_API_KEY,
} from "./constants";
import { parsePositions } from "./parse";

const zerion = defineUpstream({
  id: ID,
  label: "Zerion",
  base: ZERION_API_BASE,
  keys: [ZERION_API_KEY],
  // HTTP Basic with the key as username and an empty password.
  headers: (keys) => ({
    authorization: `Basic ${btoa(`${keys[ZERION_API_KEY]}:`)}`,
    accept: "application/json",
  }),
  limits: {
    default: {
      limit: RATE_LIMIT_BURST,
      window: Duration.seconds(RATE_LIMIT_BURST / RATE_LIMIT_PER_SEC),
      scope: "key",
    },
  },
});

export const zerionBalance = {
  ...balanceUpstream(zerion, {
    account: Schema.Struct({ address: Schema.String }),
    // Concurrent: zerion meters per key, not bursts. No chain map fails the whole fetch rather than
    // write non-canonical refs.
    fetch: (call, { creds: { address } }) =>
      Effect.all([positions(call, address), chainIds(call)], { concurrency: "unbounded" }).pipe(
        Effect.map(([res, ids]) => ({ balances: parsePositions(res, ids) })),
      ),
    verify: (call, { creds: { address } }) => portfolio(call, address),
  }),
  // A fallback for runtime source selection; `selectProvider` skips it by default.
  defaultEnabled: false,
};
