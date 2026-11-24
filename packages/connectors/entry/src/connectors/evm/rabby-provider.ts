import type { BalanceProvider, CredField, ProviderNeeds } from "@folio/connectors-basic";
import { make as makeRabbyClient, type RabbyClientApi } from "@folio/rabby-client";
import { Effect } from "effect";
import { z } from "zod";
import type { evmAccountCreds } from "./creds";
import { parseProtocols, parseTokens, type Row } from "./rabby-parse";

// Base override: unset in production; only local perf tests point it at a fake upstream.
const RABBY_BASE_KEY = "RABBY_API_BASE";
const providerCreds = [
  {
    key: RABBY_BASE_KEY,
    type: "public",
    label: "Rabby API base URL",
    validator: z.string().trim().url(),
  },
] as const satisfies readonly CredField[];

// Built per call (the gate needs a Scope); gate state is module-level, so quotas aren't reset.
const withRabby = <A, E>(
  creds: Record<string, unknown>,
  use: (client: RabbyClientApi) => Effect.Effect<A, E, ProviderNeeds>,
): Effect.Effect<A, E, ProviderNeeds> => {
  const v = creds[RABBY_BASE_KEY];
  const apiBase = typeof v === "string" && v.trim() ? v.trim() : undefined;
  return Effect.scoped(Effect.flatMap(makeRabbyClient({ apiBase }), use));
};

export const rabbyProvider: BalanceProvider<Row, typeof evmAccountCreds, typeof providerCreds> = {
  id: "rabby",
  label: "Rabby",
  creds: providerCreds,

  fetchBalances: (ctx) =>
    withRabby(ctx.creds, (client) =>
      Effect.gen(function* () {
        const address = ctx.account.creds.address;
        // Deliberately sequential (Effect.all's default): sync already runs ~6 accounts at once,
        // and 3 concurrent calls each would hit rabby's rate limit.
        const [chainIds, tokens, protocols] = yield* Effect.all([
          client.chainIds,
          client.tokens(address),
          client.protocols(address),
        ]);
        return {
          balances: [...parseTokens(tokens, chainIds), ...parseProtocols(protocols, chainIds)],
        };
      }),
    ),

  validateAccount: (ctx) =>
    withRabby(ctx.creds, (client) =>
      client.totalBalance(ctx.account.creds.address).pipe(
        Effect.as(true),
        Effect.catchTag("UpstreamAuthError", () => Effect.succeed(false)),
      ),
    ),
};
