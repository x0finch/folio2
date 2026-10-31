# Binance fixtures

Binance answers HTTP 451 to the machine these were made on, so the account fixtures are built
from the response examples in Binance's official API docs, not recorded:

- `account.json`: `GET /api/v3/account` example (spot-api-docs `rest-api.md`), balances
  replaced to cover a plain coin, a zero row, `LDO` (a real coin starting with `LD`), earn
  receipts (`LDBTC`, `LDUSDC`) and a ticker without a CoinGecko mapping (`ORDI`).
- `funding.json`: `POST /sapi/v1/asset/get-funding-asset` example, `freeze`/`withdrawing` set.
- `flexible.json`: `GET /sapi/v1/simple-earn/flexible/position` example plus a BTC row.
- `locked.json`: `GET /sapi/v1/simple-earn/locked/position` example as published.
- `prices.json`: `GET /api/v3/ticker/price` multi-symbol example plus an `ORDIUSDT` row.
- `error-*.json`: error bodies with the codes and messages from Binance's `errors.md`.

`restricted-451.json` is the one real answer: what `api.binance.com` returned to this machine.
