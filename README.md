# Folio

A self-hosted crypto portfolio tracker. Folio reads balances from on-chain wallets, Bitcoin,
centralized exchanges, perp DEXs and manual entries, prices them, and shows one portfolio:
net worth, allocation, 24h change, history and per-asset drill-down. It is read-only (no
private keys, no signing) and runs on the Cloudflare Workers free plan.

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
pnpm format        # format with oxfmt
pnpm --filter @folio/api db:generate   # after changing apps/api/src/db/schema.ts
```

## Architecture

| Path              | Package         | Description                                         |
| ----------------- | --------------- | --------------------------------------------------- |
| `apps/web`        | `@folio/web`    | TanStack Start client (static SPA), TanStack Query  |
| `apps/api`        | `@folio/api`    | Hono API on Cloudflare Workers, D1, Durable Objects |
| `packages/shared` | `@folio/shared` | Schemas and types shared by web and api             |

One Worker, configured in `wrangler.jsonc` at the repository root, serves the SPA build
through Workers Static Assets; only `/api/*` runs Worker code. The D1 schema is in
`apps/api/src/db/schema.ts`, with Drizzle migrations in `apps/api/migrations`.
