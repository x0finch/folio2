# Folio

A self-hosted crypto portfolio tracker. Folio reads balances from on-chain wallets, Bitcoin,
centralized exchanges, perp DEXs and manual entries, prices them, and shows one portfolio:
net worth, allocation, 24h change, history and per-asset drill-down. It is read-only (no
private keys, no signing) and runs on the Cloudflare Workers free plan.

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/x0finch/folio2/tree/rewrite)

## Features

- **Sources as plugins**: wallets, Bitcoin, exchanges, perp DEXs and manual holdings, each a
  folder in `packages/sources` behind one contract. The add-account form is generated from
  the plugin's config schema.
- **Pricing** from DefiLlama (keyless), FX from the ECB via Frankfurter (keyless); values in
  13 display currencies including BTC and ETH.
- **History**: hourly net worth and daily per-asset snapshots; charts from 7 days to all time;
  allocation by asset and by account.
- **Private**: exchange secrets are encrypted at rest (AES-GCM) and never returned by the API;
  everything runs in your own Cloudflare account.

## Deploy

### One click

Use the **Deploy to Cloudflare** button above. Cloudflare copies this repository to your
GitHub account, creates the `folio-db` D1 database and asks for three values (also listed in
`.dev.vars.example`):

| Name                 | Value                                                                           |
| -------------------- | ------------------------------------------------------------------------------- |
| `BETTER_AUTH_URL`    | the app's address: `https://folio.<your-subdomain>.workers.dev`, or your domain |
| `BETTER_AUTH_SECRET` | 32+ random characters, e.g. from `openssl rand -hex 32`                         |
| `ENCRYPTION_SECRET`  | 32+ random characters; encrypts exchange API secrets                            |

### From GitHub Actions

`.github/workflows/deploy.yml` deploys on demand (Actions → Deploy → Run workflow). Set the
secrets `CLOUDFLARE_API_TOKEN` (a token with the "Edit Cloudflare Workers" template plus D1
edit), `CLOUDFLARE_ACCOUNT_ID`, `BETTER_AUTH_SECRET` and `ENCRYPTION_SECRET`, and optionally
the variable `APP_URL` for a custom domain. The workflow creates the database if needed,
applies migrations, deploys and checks `/api/health`.

### Free plan

Requests stay within the free plan's 10 ms CPU. Syncing runs in SQLite-backed Durable
Object alarms (30 s CPU each): one runner per user works through that user's accounts in
batches under the per-invocation subrequest limit; an hourly cron wakes a scheduler that
queues every user.

## Development

Requires Node.js 22+ and pnpm (version pinned via `packageManager`).

```sh
pnpm install
cp .dev.vars.example .dev.vars   # then fill it in; BETTER_AUTH_URL=http://localhost:3000
pnpm --filter @folio/api db:migrate:local
pnpm dev           # web on :3000 (proxies /api) + wrangler dev on :8787
```

```sh
pnpm build         # build the SPA and bundle the Worker (dry run)
pnpm check         # format:check + lint + typecheck + test (run before pushing)
pnpm test:e2e      # build, then Playwright against wrangler dev with a stubbed price feed
pnpm --filter @folio/e2e screenshots   # key screens, desktop + phone, light + dark
pnpm --filter @folio/api db:generate   # after changing apps/api/src/db/schema.ts
pnpm --filter @folio/ui add-beui <name> # add a beUI component (packages/ui/VENDORED.md)
```

## Architecture

| Path               | Package          | Description                                               |
| ------------------ | ---------------- | --------------------------------------------------------- |
| `apps/web`         | `@folio/web`     | TanStack Start client (static SPA), TanStack Query        |
| `apps/api`         | `@folio/api`     | Hono API on Cloudflare Workers, D1, Durable Objects, cron |
| `packages/sources` | `@folio/sources` | Source plugin contract, registry and every plugin         |
| `packages/shared`  | `@folio/shared`  | Schemas and types shared by web and api                   |
| `packages/ui`      | `@folio/ui`      | Theme tokens and beUI components                          |
| `e2e`              | `@folio/e2e`     | Playwright end-to-end tests                               |

One Worker, configured in `wrangler.jsonc` at the repository root, serves the SPA build
through Workers Static Assets; only `/api/*` runs Worker code. The D1 schema is in
`apps/api/src/db/schema.ts`, with Drizzle migrations in `apps/api/migrations`.
