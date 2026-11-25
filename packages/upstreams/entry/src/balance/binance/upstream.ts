import { Duration, Effect, Fiber } from "effect";
import { balanceUpstream } from "../../runtime/balance";
import { failedBucketsNote, fetchBuckets } from "../../runtime/buckets";
import { defineUpstream } from "../../runtime/define";
import {
  BinanceCreds,
  coinmAccount,
  earnFlexible,
  earnLocked,
  fundingAssets,
  spotAccount,
  tickerPrices,
  usdmAccount,
} from "./api";
import {
  BINANCE_API_BASE,
  BINANCE_API_BASE_OVERRIDE,
  BINANCE_DELIVERY_API_BASE,
  BINANCE_DELIVERY_API_BASE_OVERRIDE,
  BINANCE_FUTURES_API_BASE,
  BINANCE_FUTURES_API_BASE_OVERRIDE,
  DELIVERY_HOST,
  FUTURES_HOST,
  ID,
  RATE_LIMITED_STATUSES,
  TICKER_LIMIT,
  TICKER_RATE_LIMIT_BURST,
  TICKER_RATE_LIMIT_PER_MIN,
} from "./constants";
import {
  type BinanceRow,
  parseAccountBalances,
  parseCoinmFuturesAccount,
  parseEarnPositions,
  parseFundingAssets,
  parseFuturesAccount,
} from "./parse";

// No deployment key: signed requests use the account's own key and stay ungated, since each
// account's quota is its own and a gate would only queue unrelated accounts.
export const binance = defineUpstream({
  id: ID,
  label: "Binance",
  base: BINANCE_API_BASE,
  baseOverride: BINANCE_API_BASE_OVERRIDE,
  hosts: {
    [FUTURES_HOST]: {
      base: BINANCE_FUTURES_API_BASE,
      baseOverride: BINANCE_FUTURES_API_BASE_OVERRIDE,
    },
    [DELIVERY_HOST]: {
      base: BINANCE_DELIVERY_API_BASE,
      baseOverride: BINANCE_DELIVERY_API_BASE_OVERRIDE,
    },
  },
  limits: {
    [TICKER_LIMIT]: {
      limit: TICKER_RATE_LIMIT_BURST,
      window: Duration.minutes(TICKER_RATE_LIMIT_BURST / TICKER_RATE_LIMIT_PER_MIN),
      scope: "egress",
    },
  },
  rateLimitedStatuses: RATE_LIMITED_STATUSES,
});

export const binanceBalance = balanceUpstream(binance, {
  account: BinanceCreds,

  fetch: (call, { creds }) =>
    Effect.gen(function* () {
      // Forked first: the gated public ticker must not hold up the signed calls.
      const prices = yield* Effect.forkChild(tickerPrices(call));

      const { ok, failed } = yield* fetchBuckets({
        Spot: spotAccount(call, creds),
        "USDⓈ-M Futures": usdmAccount(call, creds),
        "COIN-M Futures": coinmAccount(call, creds),
        Funding: fundingAssets(call, creds),
        // Either endpoint failing fails the bucket.
        Earn: Effect.all([earnFlexible(call, creds), earnLocked(call, creds)]),
      });
      const usdm = ok["USDⓈ-M Futures"];
      const { Spot: spot, "COIN-M Futures": coinm, Funding: funding, Earn: earn } = ok;

      // Every bucket but USDⓈ-M needs prices to value anything, so once one of them was read a
      // ticker failure fails the account: degrading would write a futures-only snapshot that hides
      // real holdings. Buckets that failed on their own don't wait for it, so a futures-only key
      // still syncs.
      const priced = spot ?? coinm ?? funding ?? earn;
      const priceMap = priced === undefined ? {} : yield* Fiber.join(prices);

      const balances: BinanceRow[] = [
        ...(spot ? parseAccountBalances(spot, priceMap) : []),
        ...(usdm ? parseFuturesAccount(usdm) : []),
        ...(coinm ? parseCoinmFuturesAccount(coinm, priceMap) : []),
        ...(funding ? parseFundingAssets(funding, priceMap) : []),
        ...(earn ? parseEarnPositions({ rows: earn[0] }, { rows: earn[1] }, priceMap) : []),
      ];
      const note = failedBucketsNote("Wallets not synced", failed);
      return { balances, note: note ? [note] : undefined };
    }),

  // Spot only: a key without futures permission still syncs best-effort.
  verify: (call, { creds }) => spotAccount(call, creds),
});
