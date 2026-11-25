import { Effect } from "effect";
import { binanceBalance } from "../../src/balance/binance/upstream";
import { blockbookBalance } from "../../src/balance/blockbook/upstream";
import { bybitBalance } from "../../src/balance/bybit/upstream";
import { coinstatsBalance } from "../../src/balance/coinstats/upstream";
import { decodeCustomConfig } from "../../src/balance/custom/config";
import { customBalance } from "../../src/balance/custom/upstream";
import { hyperliquidBalance } from "../../src/balance/hyperliquid/upstream";
import { okxBalance } from "../../src/balance/okx/upstream";
import { RabbySigner } from "../../src/balance/rabby/signer";
import { rabbyBalance } from "../../src/balance/rabby/upstream";
import { zerionBalance } from "../../src/balance/zerion/upstream";
import { jsonResponse as json } from "../../src/runtime/testing";
import binanceAccount from "../balance/binance/fixtures/account.json";
import binanceCoinm from "../balance/binance/fixtures/coinm-account.json";
import binanceEarnFlexible from "../balance/binance/fixtures/earn-flexible.json";
import binanceEarnLocked from "../balance/binance/fixtures/earn-locked.json";
import binanceFunding from "../balance/binance/fixtures/funding-assets.json";
import binanceFutures from "../balance/binance/fixtures/futures-account.json";
import binanceTicker from "../balance/binance/fixtures/ticker-price.json";
import blockbookAddress from "../balance/blockbook/fixtures/address.json";
import bybitEarnFlexible from "../balance/bybit/fixtures/earn-flexible.json";
import bybitEarnOnchain from "../balance/bybit/fixtures/earn-onchain.json";
import bybitFunding from "../balance/bybit/fixtures/funding.json";
import bybitWallet from "../balance/bybit/fixtures/wallet-balance.json";
import coinstatsSolana from "../balance/coinstats/fixtures/solana.json";
import customConfig from "../balance/custom/fixtures/config.json";
import customPage from "../balance/custom/fixtures/holdings-page-2.json";
import hyperliquidState from "../balance/hyperliquid/fixtures/clearinghouse-state.json";
import okxBalanceFixture from "../balance/okx/fixtures/balance.json";
import okxFunding from "../balance/okx/fixtures/funding.json";
import okxSavings from "../balance/okx/fixtures/savings.json";
import okxStaking from "../balance/okx/fixtures/staking.json";
import okxValuation from "../balance/okx/fixtures/valuation.json";
import rabbyTokens from "../balance/rabby/fixtures/cache-token-list.json";
import rabbyChains from "../balance/rabby/fixtures/chain-list.json";
import rabbyProtocols from "../balance/rabby/fixtures/complex-protocol-list.json";
import zerionChains from "../balance/zerion/fixtures/chains.json";
import zerionPositions from "../balance/zerion/fixtures/positions.json";
import { balanceContract } from "./contract";

const EVM = "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045";
const CEX = { apiKey: "s3cr3t-api-key", secret: "s3cr3t-api-secret" };
const OKX = { ...CEX, passphrase: "s3cr3t-passphrase" };

// First matching path fragment wins.
const byPath =
  (routes: readonly (readonly [string, unknown])[], fallback: unknown) =>
  ({ url }: { url: URL }) =>
    json(routes.find(([fragment]) => url.pathname.includes(fragment))?.[1] ?? fallback);

balanceContract("coinstats", {
  port: coinstatsBalance,
  account: {
    connectorId: "solana",
    creds: { address: "So11111111111111111111111111111111111111112" },
  },
  env: { COINSTATS_API_KEY: "s3cr3t-coinstats-key" },
  requiredKeys: ["COINSTATS_API_KEY"],
  reply: () => json(coinstatsSolana),
});

balanceContract("hyperliquid", {
  port: hyperliquidBalance,
  account: { connectorId: "hyperliquid", creds: { address: EVM } },
  reply: () => json(hyperliquidState),
});

balanceContract("blockbook", {
  port: blockbookBalance,
  account: {
    connectorId: "bitcoin",
    creds: { addressOrXpub: blockbookAddress.request.addressOrXpub },
  },
  reply: () => json(blockbookAddress.response),
});

const fakeSign = () =>
  Effect.succeed({ "X-Api-Sign": "contract-signature", "X-Api-Ts": "0", "X-Api-Nonce": "n" });

balanceContract("rabby", {
  port: rabbyBalance,
  account: { connectorId: "evm", creds: { address: EVM } },
  reply: byPath(
    [
      ["/chain/list", rabbyChains],
      ["/complex_protocol_list", rabbyProtocols],
      ["/cache_token_list", rabbyTokens],
    ],
    { total_usd_value: 1 },
  ),
  // The real signer is wasm that only loads on Workers.
  provide: (effect) => Effect.provideService(effect, RabbySigner, fakeSign),
});

balanceContract("zerion", {
  port: zerionBalance,
  account: { connectorId: "evm", creds: { address: EVM } },
  env: { ZERION_API_KEY: "s3cr3t-zerion-key" },
  requiredKeys: ["ZERION_API_KEY"],
  reply: byPath(
    [
      ["/v1/chains/", zerionChains],
      ["/positions/", zerionPositions],
    ],
    {},
  ),
});

balanceContract("okx", {
  port: okxBalance,
  account: { connectorId: "okx", creds: OKX },
  accountSecrets: Object.values(OKX),
  reply: byPath(
    [
      ["/asset/balances", okxFunding],
      ["/savings/balance", okxSavings],
      ["/staking-defi/orders-active", okxStaking],
      ["/asset-valuation", okxValuation],
      ["/account/positions", { code: "0", data: [] }],
    ],
    okxBalanceFixture,
  ),
});

balanceContract("bybit", {
  port: bybitBalance,
  account: { connectorId: "bybit", creds: CEX },
  accountSecrets: Object.values(CEX),
  reply: ({ url }) => {
    if (url.pathname.includes("/earn/position")) {
      return json(
        url.searchParams.get("category") === "OnChain" ? bybitEarnOnchain : bybitEarnFlexible,
      );
    }
    if (url.pathname.includes("/query-account-coins-balance")) return json(bybitFunding);
    return json(bybitWallet);
  },
});

balanceContract("binance", {
  port: binanceBalance,
  account: { connectorId: "binance", creds: CEX },
  accountSecrets: Object.values(CEX),
  reply: byPath(
    [
      ["/simple-earn/flexible/position", binanceEarnFlexible],
      ["/simple-earn/locked/position", binanceEarnLocked],
      ["/get-funding-asset", binanceFunding],
      ["/dapi/v1/account", binanceCoinm],
      ["/fapi/v2/account", binanceFutures],
      ["/api/v3/account", binanceAccount],
    ],
    binanceTicker,
  ),
});

const decodedCustom = decodeCustomConfig(JSON.stringify(customConfig));
if (!decodedCustom.ok) throw new Error(decodedCustom.message);
const CUSTOM_KEY = "s3cr3t-custom-key";

balanceContract("custom", {
  port: customBalance,
  account: {
    connectorId: "custom",
    creds: { config: decodedCustom.config, apiKey: CUSTOM_KEY, address: EVM },
  },
  env: { BETTER_AUTH_URL: "https://folio.example.com" },
  accountSecrets: [CUSTOM_KEY],
  offlineVerify: true,
  reply: () => json(customPage),
});
