import {
  type BinanceClientApi,
  type BinanceConfig,
  type BinanceCreds,
  make as makeBinanceClient,
} from "@folio/binance-client";
import type {
  BalanceProvider,
  ConnectorError,
  CredField,
  Note,
  ProviderNeeds,
} from "@folio/connectors-basic";
import { Effect, Fiber, Result } from "effect";
import { z } from "zod";
import { asConnector, bestEffortVerdict } from "../../upstream";
import { PROVIDER_ID } from "./constants";
import {
  type BinanceRow,
  parseAccountBalances,
  parseCoinmFuturesAccount,
  parseEarnPositions,
  parseFundingAssets,
  parseFuturesAccount,
} from "./parse";

// apiKey is an identifier sent in plain headers (semi); secret is the signing key.
export const binanceAccountCreds = [
  { key: "apiKey", type: "semi", label: "API Key", validator: z.string().trim().min(1) },
  { key: "secret", type: "secret", label: "API Secret", validator: z.string().trim().min(1) },
] as const satisfies readonly CredField[];

// Optional proxy bases, for when Binance geo-blocks the Workers egress IP. Declared as provider
// creds so the app injects them from env. Values may embed a proxy key: never log them.
const BASE_OVERRIDE = {
  apiBase: "BINANCE_API_BASE",
  fapiBase: "BINANCE_FAPI_BASE",
  dapiBase: "BINANCE_DAPI_BASE",
} as const;

const baseUrlSchema = z.string().trim().url();

const configFrom = (creds: Record<string, unknown>): BinanceConfig => {
  const pick = (key: string): string | undefined => {
    const v = creds[key];
    return typeof v === "string" && v.trim() ? v.trim() : undefined;
  };
  return {
    apiBase: pick(BASE_OVERRIDE.apiBase),
    fapiBase: pick(BASE_OVERRIDE.fapiBase),
    dapiBase: pick(BASE_OVERRIDE.dapiBase),
  };
};

// One account = several isolated wallets fetched concurrently with the same key. `prices` is a
// Fiber so the gated public ticker runs alongside the signed calls; only wallets needing USD join it.
interface Wallet {
  readonly name: string; // shown in the failure note
  readonly rows: (
    client: BinanceClientApi,
    creds: BinanceCreds,
    prices: Fiber.Fiber<Record<string, number>, ConnectorError>,
  ) => Effect.Effect<BinanceRow[], ConnectorError, ProviderNeeds>;
}

const spot: Wallet = {
  name: "Spot",
  rows: (client, creds, prices) =>
    Effect.all([asConnector(client.spotAccount(creds)), Fiber.join(prices)]).pipe(
      Effect.map(([account, priceMap]) => parseAccountBalances(account, priceMap)),
    ),
};

// Futures report USD themselves, so this wallet doesn't join the price table.
const usdmFutures: Wallet = {
  name: "USDⓈ-M Futures",
  rows: (client, creds) =>
    asConnector(client.usdmAccount(creds)).pipe(Effect.map(parseFuturesAccount)),
};

const coinmFutures: Wallet = {
  name: "COIN-M Futures",
  rows: (client, creds, prices) =>
    Effect.all([asConnector(client.coinmAccount(creds)), Fiber.join(prices)]).pipe(
      Effect.map(([account, priceMap]) => parseCoinmFuturesAccount(account, priceMap)),
    ),
};

const funding: Wallet = {
  name: "Funding",
  rows: (client, creds, prices) =>
    Effect.all([asConnector(client.fundingAssets(creds)), Fiber.join(prices)]).pipe(
      Effect.map(([assets, priceMap]) => parseFundingAssets(assets, priceMap)),
    ),
};

// Either of the two endpoints failing fails the wallet.
const earn: Wallet = {
  name: "Earn",
  rows: (client, creds, prices) =>
    Effect.all([
      asConnector(client.earnFlexible(creds)),
      asConnector(client.earnLocked(creds)),
      Fiber.join(prices),
    ]).pipe(
      Effect.map(([flexible, locked, priceMap]) =>
        parseEarnPositions({ rows: flexible }, { rows: locked }, priceMap),
      ),
    ),
};

const WALLETS: readonly Wallet[] = [spot, usdmFutures, coinmFutures, funding, earn];

// Only reached for permanent failures (transient ones already failed the account): missing
// permissions vs. a changed response shape get different hints.
const walletFailureNote = (failed: readonly { name: string; auth: boolean }[]): Note => ({
  title: "Wallets not synced",
  icon: "warning",
  content: `${failed.map((f) => f.name).join(" / ")} — ${
    failed.some((f) => f.auth) ? "check the API key's permissions" : "couldn't be read this round"
  }`,
});

// Pure verdict over collected outcomes. Binance-specific rule: if any wallet died *on the price
// table* (same error object from `Fiber.join`, not just the same tag), fail the whole account
// with that error. Four wallets share it, and degrading would write a futures-only snapshot that
// hides their real holdings. A wallet that failed on its own signed call doesn't count, so a
// futures-only key still syncs.
export interface WalletOutcome {
  readonly wallet: { readonly name: string };
  readonly result: Result.Result<BinanceRow[], ConnectorError>;
}

export const verdict = (
  outcomes: readonly WalletOutcome[],
  priceTable: Result.Result<unknown, ConnectorError>,
): Result.Result<{ balances: BinanceRow[]; note?: Note[] }, ConnectorError> => {
  // Regardless of retryability: the dependent wallets got no data either way.
  if (Result.isFailure(priceTable)) {
    const collateral = outcomes.some(
      (o) => Result.isFailure(o.result) && o.result.failure === priceTable.failure,
    );
    if (collateral) return Result.fail(priceTable.failure);
  }

  const verdicted = bestEffortVerdict(outcomes);
  if (Result.isFailure(verdicted)) return Result.fail(verdicted.failure);
  const failed = verdicted.success;

  return Result.succeed({
    balances: outcomes.flatMap((o) => (Result.isSuccess(o.result) ? o.result.success : [])),
    note: failed.length
      ? [
          walletFailureNote(
            failed.map((o) => ({
              name: o.wallet.name,
              auth: Result.isFailure(o.result) && o.result.failure._tag === "ConnectorAuthError",
            })),
          ),
        ]
      : undefined,
  });
};

// Built per call rather than as a shared Layer: base overrides only exist in `ctx.creds`, and the
// gate's state is module-level, so rebuilding the client doesn't reset rate-limit buckets.
const withClient = <A, E>(
  creds: Record<string, unknown>,
  use: (client: BinanceClientApi) => Effect.Effect<A, E, ProviderNeeds>,
): Effect.Effect<A, E, ProviderNeeds> =>
  Effect.scoped(Effect.flatMap(makeBinanceClient(configFrom(creds)), use));

export const binanceProvider: BalanceProvider<BinanceRow, typeof binanceAccountCreds> = {
  id: PROVIDER_ID,
  label: "Binance",
  // Not real credentials: env-injected base URL overrides. Not shown in forms, encrypted or exported.
  creds: [
    {
      key: BASE_OVERRIDE.apiBase,
      type: "public",
      label: "Spot API base URL",
      validator: baseUrlSchema,
    },
    {
      key: BASE_OVERRIDE.fapiBase,
      type: "public",
      label: "USDⓈ-M API base URL",
      validator: baseUrlSchema,
    },
    {
      key: BASE_OVERRIDE.dapiBase,
      type: "public",
      label: "COIN-M API base URL",
      validator: baseUrlSchema,
    },
  ],

  fetchBalances: (ctx) =>
    withClient(ctx.creds, (client) =>
      Effect.gen(function* () {
        const creds = ctx.account.creds;

        // Forked first: the ticker is rate-gated by egress IP and must not hold up signed calls.
        const prices = yield* Effect.forkChild(asConnector(client.tickerPrices));

        // `either` + `all` rather than `partition`: each outcome keeps its wallet, whose name the
        // failure note needs.
        const outcomes = yield* Effect.all(
          WALLETS.map((wallet) =>
            Effect.result(wallet.rows(client, creds, prices)).pipe(
              Effect.map((result) => ({ wallet, result })),
            ),
          ),
          { concurrency: "unbounded" },
        );

        // Usually already complete; otherwise bounded by sync's per-call timeout.
        const priceTable = yield* Effect.result(Fiber.join(prices));

        return yield* Effect.fromResult(verdict(outcomes, priceTable));
      }),
    ),

  // Spot only: partial permissions (e.g. no futures) are best-effort at sync time, not a reason to
  // reject the account.
  validateAccount: (ctx) =>
    withClient(ctx.creds, (client) =>
      asConnector(client.spotAccount(ctx.account.creds)).pipe(
        Effect.as(true),
        Effect.catchTag("ConnectorAuthError", () => Effect.succeed(false)),
      ),
    ),
};
