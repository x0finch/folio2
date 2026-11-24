import type { BalanceProvider, CredField, ProviderNeeds } from "@folio/connectors-basic";
import { UpstreamAuthError, type UpstreamError } from "@folio/upstream-basic";
import { make as makeZerionClient, type ZerionClientApi } from "@folio/zerion-client";
import { Effect } from "effect";
import { z } from "zod";
import type { evmAccountCreds } from "./creds";
import { parsePositions, type Row } from "./zerion-parse";

const ZERION_API_KEY = "ZERION_API_KEY";

// Injected from env.
const zerionProviderCreds = [
  { key: ZERION_API_KEY, type: "secret", validator: z.string().min(1), label: "Zerion API Key" },
] as const satisfies readonly CredField[];

const withZerion = <A, E>(
  use: (client: ZerionClientApi) => Effect.Effect<A, E, ProviderNeeds>,
): Effect.Effect<A, E, ProviderNeeds> => Effect.scoped(Effect.flatMap(makeZerionClient(), use));

// A missing env key is a credentials problem, not a request to fire.
const zerionKeyOf = (creds: Record<string, string>): Effect.Effect<string, UpstreamError> => {
  const apiKey = creds[ZERION_API_KEY];
  return apiKey
    ? Effect.succeed(apiKey)
    : Effect.fail(
        new UpstreamAuthError({
          upstream: "zerion",
          where: "(config)",
          cause: `${ZERION_API_KEY} not configured`,
        }),
      );
};

export const zerionProvider: BalanceProvider<
  Row,
  typeof evmAccountCreds,
  typeof zerionProviderCreds
> = {
  id: "zerion",
  label: "Zerion",
  creds: zerionProviderCreds,
  // Fallback source for runtime source selection; `selectProvider` skips it by default.
  defaultEnabled: false,

  fetchBalances: (ctx) =>
    zerionKeyOf(ctx.creds).pipe(
      Effect.flatMap((apiKey) =>
        withZerion((client) =>
          // Concurrent (zerion meters per key, not burst). No chain map → fail the whole fetch
          // rather than write a snapshot with non-canonical refs.
          Effect.all(
            [
              client.positions({ address: ctx.account.creds.address, apiKey }),
              client.chainIds(apiKey),
            ],
            { concurrency: "unbounded" },
          ).pipe(
            Effect.map(([positions, chainIds]) => ({
              balances: parsePositions(positions, chainIds),
            })),
          ),
        ),
      ),
    ),

  // A missing key also lands here as an auth error, i.e. `false`.
  validateAccount: (ctx) =>
    zerionKeyOf(ctx.creds).pipe(
      Effect.flatMap((apiKey) =>
        withZerion((client) => client.portfolio({ address: ctx.account.creds.address, apiKey })),
      ),
      Effect.as(true),
      Effect.catchTag("UpstreamAuthError", () => Effect.succeed(false)),
    ),
};
