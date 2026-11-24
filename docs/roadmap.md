# Folio Roadmap

## Where it stands

Folio is a multi-source portfolio tracker with unified pricing, multi-currency display and analysis: on-chain, CEX, perp, manual and Bitcoin (address + xpub) balances → normalized to USD → aggregated per token → shown as holdings, 24h gain, allocation, per-asset drill-down and net-worth history, in fiat or BTC/ETH. Accounts are grouped into portfolios and tagged.

**The main gap: transactions and cost basis.** Folio can't yet answer "how much did I make or lose".

## Order

1. **Transactions** — a `transactions` table plus ingestion per source. The only large missing piece; snapshot rows already store per-asset `usd_value` and `self_price`.
2. **Cost basis and P&L** — on top of transactions.
3. **Tax and reports** — on top of P&L.

In parallel, smaller items: more time ranges, alerts, broader source coverage (new sources are cheap: a client package plus a connector manifest), polish.

## Out of scope

Social features / following other wallets, trade execution or signing (Folio is read-only and holds no keys), market making or trading terminals, native mobile apps, multi-user collaboration. Folio stays a personal, self-hosted portfolio tracker.

## Reference products

- **Zerion / DeBank** — on-chain and DeFi detail across chains (→ source coverage).
- **CoinStats** — CEX + on-chain, alerts, multi-currency (→ alerts).
- **Rotki** — self-hosted, cost basis, tax, privacy; the closest fit (→ P&L, tax).
