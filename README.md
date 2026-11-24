# Folio

A self-hosted crypto portfolio tracker: on-chain wallets, Bitcoin, CEX, perp DEX and manual assets in one dashboard.

Folio pulls balances **read-only** from every source you use, normalizes them through a per-user token layer into USD, and shows one portfolio — holdings, 24h gain, allocation, net-worth history and per-asset drill-down — in the currency of your choice (fiat or BTC/ETH). It runs entirely on your own Cloudflare account.

## Features

- **Sources** — EVM chains (Rabby by default, Zerion optional), Solana / Sui / Cosmos (CoinStats), Bitcoin (addresses and xpub/ypub/zpub via Trezor Blockbook), CEX (Binance, OKX, Bybit), perp DEX (Hyperliquid), and manual holdings.
- **Pricing** — CoinGecko market prices; the same token across chains and venues aggregates into one holding.
- **Multi-currency** — about 10 fiat currencies or BTC/ETH; USD is the base, conversion happens only for display.
- **Analysis** — allocation, 24h gain, net-worth history, portfolios and tags.
- **Read-only and private** — no private keys, no signing; per-account secrets are AES-GCM encrypted at rest.

## Stack

TanStack Start + Vite · Cloudflare Workers + D1 (SQLite) + Drizzle · better-auth · Effect · pnpm workspace · TypeScript · Vitest · Biome.

## Setup

Prerequisites: Node, `pnpm@10`, a Cloudflare account (for deploy).

```bash
pnpm install
cp apps/web/.dev.vars.example apps/web/.dev.vars   # fill in the secrets below
pnpm --filter @folio/web db:migrate:local          # apply D1 migrations locally
pnpm dev                                            # → http://localhost:3000
```

Secrets in `apps/web/.dev.vars`:

- `SECRETS_KEY` — `openssl rand -base64 32` (AES-GCM key for per-account credentials).
- `BETTER_AUTH_SECRET`, `BETTER_AUTH_URL` — auth.
- Provider keys (optional, per source): `COINSTATS_API_KEY` (Solana/Sui/Cosmos), `COINGECKO_API_KEY` (pricing), `ZERION_API_KEY` (alternative EVM source). EVM and Bitcoin need no key.

## Common commands

| Command | What it does |
|---|---|
| `pnpm dev` | Dev server on port 3000 |
| `pnpm test` | All package and app tests |
| `pnpm typecheck` | `tsc --noEmit` in every package |
| `pnpm lint` / `pnpm lint:fix` | Biome check / write |
| `pnpm knip` | Unused files, exports and dependencies |
| `pnpm coverage` | Repo-wide istanbul coverage (CI requires ≥ 80%) |
| `pnpm build` | Production build |
| `pnpm --filter @folio/web db:migrate:local` | Apply migrations to the local D1 |
| `pnpm --filter @folio/web test:e2e` | Playwright end-to-end tests |

## Docs

- [apps/web/DEPLOY.md](apps/web/DEPLOY.md) — deploying to Cloudflare Workers.
- [docs/roadmap.md](docs/roadmap.md) — forward scope.
- [CLAUDE.md](CLAUDE.md) — engineering conventions.

Folio is read-only by design and never holds private keys.

## License

No license yet; all rights reserved by default.
