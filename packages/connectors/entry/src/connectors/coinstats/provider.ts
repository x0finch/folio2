import { type CoinstatsClientApi, make as makeCoinstatsClient } from "@folio/coinstats-client";
import type {
  BalanceProvider,
  CredField,
  FetchContext,
  ProviderNeeds,
} from "@folio/connectors-basic";
import { UpstreamAuthError, type UpstreamError } from "@folio/upstream-basic";
import { Effect } from "effect";
import { z } from "zod";
import { COINSTATS_API_KEY, PROVIDER_ID } from "./constants";
import { parseBalances, type Row } from "./parse";

// Only non-empty: address formats differ per chain, so the API is the judge.
export const coinstatsAccountCreds = [
  { key: "address", type: "public", label: "Wallet Address", validator: z.string().trim().min(1) },
] as const satisfies readonly CredField[];

// The API key is injected from env. The base override is unset in production; only local perf
// tests point it at a fake upstream.
const COINSTATS_BASE_KEY = "COINSTATS_API_BASE";
const providerCreds = [
  {
    key: COINSTATS_API_KEY,
    type: "secret",
    validator: z.string().min(1),
    label: "CoinStats API Key",
  },
  {
    key: COINSTATS_BASE_KEY,
    type: "public",
    validator: z.string().trim().url(),
    label: "CoinStats API base URL",
  },
] as const satisfies readonly CredField[];

type CoinstatsCtx = FetchContext<{ address: string }, Record<string, string>>;

// Built per call (the gate needs a Scope). The quota queue is keyed by the key's name, not the
// client instance, so all three chains still share one queue.
const withClient = <A, E>(
  creds: Record<string, unknown>,
  use: (client: CoinstatsClientApi) => Effect.Effect<A, E, ProviderNeeds>,
): Effect.Effect<A, E, ProviderNeeds> => {
  const v = creds[COINSTATS_BASE_KEY];
  const apiBase = typeof v === "string" && v.trim() ? v.trim() : undefined;
  return Effect.scoped(Effect.flatMap(makeCoinstatsClient({ apiBase }), use));
};

// A missing env key is a credentials problem (retrying won't help), not a request to fire.
const apiKeyOf = (ctx: CoinstatsCtx): Effect.Effect<string, UpstreamError> => {
  const apiKey = ctx.creds[COINSTATS_API_KEY];
  return apiKey
    ? Effect.succeed(apiKey)
    : Effect.fail(
        new UpstreamAuthError({
          upstream: PROVIDER_ID,
          where: "(config)",
          cause: `${COINSTATS_API_KEY} not configured`,
        }),
      );
};

const balanceOf = (
  connectionId: string,
  ctx: CoinstatsCtx,
): Effect.Effect<Row[], UpstreamError, ProviderNeeds> =>
  apiKeyOf(ctx).pipe(
    Effect.flatMap((apiKey) =>
      withClient(ctx.creds, (client) =>
        client.balance({ connectionId, address: ctx.account.creds.address, apiKey }),
      ),
    ),
    // Coins without a chain fall back to connectionId (including sui's "sui-wallet").
    Effect.map((coins) => parseBalances(coins, connectionId)),
  );

export function createCoinstatsProvider(
  connectionId: string,
): BalanceProvider<Row, typeof coinstatsAccountCreds, typeof providerCreds> {
  return {
    id: PROVIDER_ID,
    label: "CoinStats",
    creds: providerCreds,

    fetchBalances: (ctx) =>
      balanceOf(connectionId, ctx).pipe(Effect.map((balances) => ({ balances }))),

    // A missing key also lands here: `apiKeyOf` reports it as an auth error, which means `false`.
    validateAccount: (ctx) =>
      balanceOf(connectionId, ctx).pipe(
        Effect.as(true),
        Effect.catchTag("UpstreamAuthError", () => Effect.succeed(false)),
      ),
  };
}
