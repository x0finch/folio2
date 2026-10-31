# @folio/sources

Every data source Folio reads is a plugin here: one folder, one `defineSource()` call. Plugins
fetch and normalize; they never touch the database, pricing or each other. The sync engine
runs them inside a Durable Object alarm with a subrequest budget.

## The contract

```ts
defineSource({
  id: 'example', // stored with every connection: never rename
  kind: 'wallet', // 'wallet' | 'exchange' | 'perp' | 'manual'
  label: 'Example',
  description: 'One line for the source picker',
  // The form and the stored config. `field()` and `secret()` attach the form metadata;
  // secret fields are encrypted at rest and never returned by the API.
  config: z.object({
    address: field({ title: 'Address', placeholder: '0x…' }),
    apiSecret: secret({ title: 'API secret' }),
  }),
  maxRequests: (config) => 3, // most subrequests one fetch may need
  defaultLabel: (config) => short(config.address),
  validate: async (ctx) => {}, // optional: runs when a connection is saved
  fetchPositions: async (ctx) => [], // returns Position[]
})
```

`ctx` holds the parsed `config` (secrets decrypted), a budgeted `fetch`, a `log` and `now`.
Use `fetchJson(ctx.fetch, url, zodSchema)` for JSON APIs: it validates the answer and maps
HTTP errors to `SourceError` codes (`unauthorized`, `rate_limited`, `upstream`...). Throw
`SourceError('invalid_config', …)` for a config the upstream rejects.

A `Position` names its asset (`coingecko:<id>` or `<chain>:<address>`), an amount as a decimal
string, and a kind (`spot`, `staked`, `lending`, `borrowed`, `reward`, `perp`). Return
`priceUsd` when the venue prices the asset, `valueUsd` when it knows the value better than
amount × price (perp equity), and `perp` details for perp positions.

## Adding a source

1. Create `src/<id>/index.ts` and export the source built with `defineSource()`.
2. Describe the config with `field()` / `secret()`; add `.regex()`/`.refine()` checks for
   addresses so mistakes are caught before any request.
3. Implement `fetchPositions` with `fetchJson` and zod schemas for every upstream answer.
4. Keep `maxRequests` honest: the engine defers a source when less budget is left.
5. Record real upstream answers (redacted) as fixtures in `test/fixtures/<id>/`.
6. Write `test/<id>.test.ts` with `contextFor()` and `fixtureFetch()` from `src/testing.ts`:
   golden positions, error mapping, and that no secret reaches `ctx.log`.
7. List the source in `src/registry.ts`.
8. Add a short section about the upstream (limits, key needed or not) to this README.

The registry test fails if a source has no `test/<id>.test.ts`.

## Sources

- `manual` — holdings entered by hand; no requests.
- `binance` — Binance REST (`api.binance.com`) with a read-only API key + secret (HMAC-SHA256,
  hex). Spot (`/api/v3/account`), funding (`/sapi/v1/asset/get-funding-asset`) and Simple Earn
  flexible (`lending`) and locked (`staked`) positions, first page of 100 each; `LD*` earn
  receipts map to their coin. Unknown tickers are priced from `/api/v3/ticker/price` (USDT
  pairs). At most 5 requests, about 50 of the 6,000 request weight per minute. Binance answers
  451 to some regions (US among them). Futures and margin are not read yet.
- `okx` — OKX v5 (`www.okx.com`) with a read-only API key, secret and passphrase (HMAC-SHA256,
  base64). Trading account (`/api/v5/account/balance`, coin equity with USD values) and funding
  (`/api/v5/asset/balances`); unknown currencies priced from `/api/v5/market/tickers` (public).
  At most 3 requests. Keys from regional sites (EEA, US) or demo trading are rejected. Derivative
  positions are not listed yet (their unrealized PnL is in the coin equity).
- `bybit` — Bybit v5 (`api.bybit.com`) with a read-only API key + secret (HMAC-SHA256, hex).
  Unified Trading Account (`/v5/account/wallet-balance`, coin equity with USD values) and
  Funding (`/v5/asset/transfer/query-account-coins-balance`); unknown coins priced from
  `/v5/market/tickers` (public). At most 3 requests. Classic (non-unified) accounts and keys
  from regional sites are not supported; Bybit's CDN answers 403 to blocked regions. Derivative
  positions are not listed yet (their unrealized PnL is in the coin equity).

Exchange tickers become asset ids through one map, `src/tickers.ts`: listed coins get their
CoinGecko id, anything else is `cex:<TICKER>` with the venue's USDT price as `priceUsd`.

- `evm` — one EVM address on Ethereum, Arbitrum, Base, Optimism, Polygon, BNB Chain, Avalanche,
  Gnosis, Linea, Scroll and zkSync. No key. Native balances come from each chain's public
  JSON-RPC (`eth_getBalance` on publicnode.com, mainnet.era.zksync.io); ERC-20 tokens from
  LI.FI's keyless `GET li.quest/v1/wallets/<address>/balances?extended=true`, which covers all
  chains in one call and prices each token. Tokens without a LI.FI price or worth under $1 are
  dropped as spam. LI.FI allows about 10 keyless calls a minute per IP and currently returns no
  Polygon tokens (Polygon shows POL only). 12 requests.
- `solana` — one Solana address. No key. SOL via `getBalance` and SPL tokens of the Token and
  Token-2022 programs via `getTokenAccountsByOwner` (jsonParsed) on the public mainnet RPC;
  symbol, name, logo and price from Jupiter's keyless `lite-api.jup.ag/tokens/v2/search` (100
  mints per call, at most 3 calls). Looked-up tokens without a Jupiter price or worth under $1
  are dropped; NFTs (0 decimals) are skipped; mints past the 300-mint lookup cap are kept with a
  shortened mint as symbol. Both upstreams throttle bursts (the RPC answers JSON-RPC error 429).
  Staked SOL is not read. 6 requests.
