# OKX fixtures

OKX is reachable from the machine these were made on, but there was no API key to record a
real account with, so:

- `account-balance.json`: `GET /api/v5/account/balance` example from OKX's official v5 docs
  (the USDT row as published) plus BTC, PEOPLE (no CoinGecko mapping), a negative (borrowed)
  ETH row and a zero SOL row.
- `asset-balances.json`: `GET /api/v5/asset/balances` example (the ETH row) plus an ORDI row
  with a frozen part.
- `market-tickers.json`: recorded live from `GET /api/v5/market/tickers?instType=SPOT`,
  trimmed to the few pairs the tests use (the full answer lists about 1,200 pairs).
- `error-50119.json`, `error-50103.json`: recorded live, the answers (HTTP 401) to a made-up
  key and to a request without a key.
- `error-50113.json`, `error-50105.json`: built from OKX's error code table.
