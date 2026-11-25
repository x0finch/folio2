import { Effect, Schema } from "effect";
import { balanceUpstream } from "../../runtime/balance";
import { defineUpstream } from "../../runtime/define";
import { walletBalance } from "./api";
import {
  API_KEY_HEADER,
  COINSTATS_API_BASE,
  COINSTATS_API_BASE_OVERRIDE,
  COINSTATS_API_KEY,
  CONNECTION_BY_CONNECTOR,
  ID,
  RATE_LIMIT_BURST,
  RATE_LIMIT_WINDOW_MS,
} from "./constants";
import { parseBalances } from "./parse";

const coinstats = defineUpstream({
  id: ID,
  label: "CoinStats",
  base: COINSTATS_API_BASE,
  baseOverride: COINSTATS_API_BASE_OVERRIDE,
  keys: [COINSTATS_API_KEY],
  headers: (keys) => ({ [API_KEY_HEADER]: keys[COINSTATS_API_KEY], accept: "application/json" }),
  limits: {
    default: { limit: RATE_LIMIT_BURST, window: RATE_LIMIT_WINDOW_MS, scope: "key" },
  },
});

export const coinstatsBalance = balanceUpstream(coinstats, {
  account: Schema.Struct({ address: Schema.String }),
  fetch: (call, { connectorId, creds }) =>
    Effect.suspend(() => {
      const connectionId = CONNECTION_BY_CONNECTOR[connectorId] ?? connectorId;
      return walletBalance(call, { connectionId, address: creds.address }).pipe(
        Effect.map((coins) => ({ balances: parseBalances(coins, connectionId) })),
      );
    }),
});
