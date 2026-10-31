# Bybit fixtures

Bybit's CDN answers HTTP 403 ("configured to block access from your country") to the machine
these were made on, so they are built from the response examples in Bybit's official v5 docs,
not recorded:

- `wallet-balance.json`: `GET /v5/account/wallet-balance` example (its BTC row is all zeros),
  with rows added for a positive coin, a coin with unrealized PnL, a negative (borrowed) coin
  and a coin without a CoinGecko mapping or USD value (`PEOPLE`).
- `fund-balance.json`: `GET /v5/asset/transfer/query-account-coins-balance` example (a zero
  USDC row) plus USDT and ORDI rows.
- `market-tickers.json`: `GET /v5/market/tickers?category=spot` example plus ORDI and PEOPLE.
- `error-*.json`: the v5 envelope with codes and messages from Bybit's error code page.
