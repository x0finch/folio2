# Deploying Folio to Cloudflare Workers (self-host)

Folio runs on Cloudflare Workers + D1. This is a one-time setup; afterwards `pnpm run deploy` ships updates.

**Prerequisites:** a Cloudflare account; this repo cloned with `pnpm install` done (Wrangler is a dev dependency). Run everything below from `apps/web/`.

## What you provide (secrets)

Production needs **5 secrets** + 1 plaintext var (already in `wrangler.jsonc`: `LOG_LEVEL=info`).
Generate the two random ones locally:

```sh
openssl rand -base64 32   # → SECRETS_KEY      (AES-GCM key; encrypts the `secret` creds fields)
openssl rand -hex 32      # → BETTER_AUTH_SECRET (session signing)
```

`ZERION_API_KEY` (free tier: developers.zerion.io) and `COINSTATS_API_KEY` (free: openapi.coinstats.app) are the global on-chain provider keys. `BETTER_AUTH_URL` is your deployed origin (set after step 5).

> Exchange API keys (Binance/OKX) are **not** deployment config — you enter them per-account in the UI; they're encrypted into D1. Only the 5 secrets below are env.

## Steps

```sh
cd apps/web

# 1. Authenticate Wrangler with your Cloudflare account
pnpm exec wrangler login

# 2. Create the remote D1 database, then paste the printed `database_id`
#    into wrangler.jsonc → d1_databases[0].database_id
pnpm exec wrangler d1 create folio

# 3. Apply migrations to the REMOTE D1 (local & remote are separate DBs)
pnpm exec wrangler d1 migrations apply folio --remote

# 4. Set secrets (each prompts for the value — never written to git)
pnpm exec wrangler secret put SECRETS_KEY
pnpm exec wrangler secret put BETTER_AUTH_SECRET
pnpm exec wrangler secret put ZERION_API_KEY
pnpm exec wrangler secret put COINSTATS_API_KEY
pnpm exec wrangler secret put BETTER_AUTH_URL    # placeholder for now (e.g. https://example.com); fixed in step 6

# 5. Build + deploy (the `deploy` script runs `vite build` then `wrangler deploy`)
pnpm run deploy
# → note the printed URL, e.g. https://folio-web.<your-subdomain>.workers.dev

# 6. better-auth needs BETTER_AUTH_URL to match the real origin → set it and redeploy
pnpm exec wrangler secret put BETTER_AUTH_URL     # the workers.dev URL from step 5
pnpm run deploy
```

**Custom domain:** bind a Workers Custom Domain in the Cloudflare dashboard, then use that domain for `BETTER_AUTH_URL` in step 6.

## Verify

1. Open the URL → **sign up** → you land on the overview.
2. Add a **manual** account (symbol/amount/usd) → **Sync now** → it appears with a total.
3. (Optional) add an on-chain wallet (needs `ZERION_API_KEY` reachable) → Sync.
4. Logs: `pnpm exec wrangler tail` — structured JSON lines (`account synced` with `userId`/`accountId`/`type`, etc.). The daily cron (`0 0 * * *` UTC) auto-runs; trigger it manually from the dashboard (Workers → folio-web → Triggers / Cron) to see a `cron sweep done` line.

## Updating later

```sh
cd apps/web
# if schema changed: pnpm --filter @folio/db exec drizzle-kit generate, then:
pnpm exec wrangler d1 migrations apply folio --remote
pnpm run deploy
```

## Notes

- **Local vs remote D1 are separate.** `pnpm dev` uses a local SQLite file; production uses the remote D1. Always `migrations apply … --remote` after a schema change.
- **Logging:** production emits JSON Lines into **Workers Logs** (Dashboard → Observability, queryable; 7-day retention). `LOG_PRETTY` is intentionally unset in prod (it's local-dev only). Adjust verbosity via the `LOG_LEVEL` var in `wrangler.jsonc`.
- **Secrets** are encrypted and only exist in the deployed Worker; rotate with another `wrangler secret put <NAME>`. They are never in git.
