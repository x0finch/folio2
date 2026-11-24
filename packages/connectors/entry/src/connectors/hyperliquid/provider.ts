import type { CredField } from "@folio/connectors-basic";
import {
  type ClearinghouseState,
  type HyperliquidClientApi,
  make as makeClient,
} from "@folio/hyperliquid-client";
import type { BalanceUpstream, UpstreamError, UpstreamNeeds } from "@folio/upstream-basic";
import { Effect } from "effect";
import { z } from "zod";
import { EVM_ADDRESS_RE } from "./constants";
import { PROVIDER_ID, parseClearinghouseState, type Row } from "./parse";

export const hyperliquidAccountCreds = [
  {
    key: "address",
    type: "public",
    label: "EVM Address",
    desc: "0x + 40 hex",
    validator: z.string().regex(EVM_ADDRESS_RE, "expected 0x + 40 hex"),
  },
] as const satisfies readonly CredField[];

// Unset in production; only local perf tests point it at a fake upstream.
const HYPERLIQUID_BASE_KEY = "HYPERLIQUID_API_BASE";

// No rate gate, so construction is pure and needs no Scope; build the default once.
const defaultClient: HyperliquidClientApi = makeClient();

const clientFor = (creds: Record<string, unknown>): HyperliquidClientApi => {
  const v = creds[HYPERLIQUID_BASE_KEY];
  return typeof v === "string" && v.trim() ? makeClient({ apiBase: v.trim() }) : defaultClient;
};

const providerCreds = [
  {
    key: HYPERLIQUID_BASE_KEY,
    type: "public",
    label: "Hyperliquid API base URL",
    validator: z.string().trim().url(),
  },
] as const satisfies readonly CredField[];

export const hyperliquidProvider: BalanceUpstream<
  Row,
  typeof hyperliquidAccountCreds,
  typeof providerCreds
> = {
  id: PROVIDER_ID,
  label: "Hyperliquid",
  creds: providerCreds,

  fetchBalances: (ctx) =>
    state(clientFor(ctx.creds), ctx.account.creds.address).pipe(
      Effect.map((json) => ({ balances: parseClearinghouseState(json) })),
    ),

  // Never-traded addresses return 200 + empty state (valid). The info endpoint has no auth, but
  // the auth branch stays because the contract requires separating the two failure kinds.
  validateAccount: (ctx) =>
    state(clientFor(ctx.creds), ctx.account.creds.address).pipe(
      Effect.as(true),
      Effect.catchTag("UpstreamAuthError", () => Effect.succeed(false)),
    ),
};

const state = (
  client: HyperliquidClientApi,
  address: string,
): Effect.Effect<ClearinghouseState, UpstreamError, UpstreamNeeds> =>
  client.clearinghouseState(address);
