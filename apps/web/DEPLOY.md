# Deploying Folio to Cloudflare Workers

Folio runs on Cloudflare Workers + D1. Setup is one-time; afterwards `pnpm run deploy` (or a tag) ships updates.

**Prerequisites:** a Cloudflare account and this repo with `pnpm install` done (Wrangler is a dev dependency). Run everything from `apps/web/`.

## Secrets

Production needs these Worker secrets (the plaintext `LOG_LEVEL=info` is already in `wrangler.jsonc`):

- `SECRETS_KEY` — `openssl rand -base64 32` (AES-GCM key for secret credential fields).
- `BETTER_AUTH_SECRET` — `openssl rand -hex 32`.
- `BETTER_AUTH_URL` — the deployed origin (set in step 6).
- `COINSTATS_API_KEY` — Solana / Sui / Cosmos (free at openapi.coinstats.app). EVM (Rabby) and Bitcoin (public Blockbook) need no key.
- Optional: `COINGECKO_API_KEY` (demo key; lifts the keyless rate limit) or `COINGECKO_PRO_API_KEY` (paid plan), `ZERION_API_KEY` (alternative EVM source).

Exchange API keys are not deployment config: users enter them per account in the UI and they are encrypted into D1.

## First deploy

```sh
cd apps/web

# 1. Authenticate
pnpm exec wrangler login

# 2. Create the remote D1, then paste the printed database_id into
#    wrangler.jsonc → d1_databases[0].database_id
pnpm exec wrangler d1 create folio

# 3. Apply migrations to the REMOTE D1 (local and remote are separate databases)
pnpm exec wrangler d1 migrations apply folio --remote

# 4. Secrets (each prompts for its value)
pnpm exec wrangler secret put SECRETS_KEY
pnpm exec wrangler secret put BETTER_AUTH_SECRET
pnpm exec wrangler secret put COINSTATS_API_KEY
pnpm exec wrangler secret put BETTER_AUTH_URL     # placeholder for now, fixed in step 6
pnpm exec wrangler secret put COINGECKO_API_KEY   # optional

# 5. Build + deploy → note the printed https://folio.<subdomain>.workers.dev
pnpm run deploy

# 6. better-auth needs BETTER_AUTH_URL to match the real origin
pnpm exec wrangler secret put BETTER_AUTH_URL
pnpm run deploy

# 7. Fill the global token map once (contract address → CoinGecko coin); without it on-chain
#    tokens get no price or logo. The daily workflow keeps it fresh afterwards.
CLOUDFLARE_API_TOKEN=<token with D1:Edit> pnpm run ref-index:refresh
```

Background jobs need no setup: they run in the `JobRunner` Durable Object, which `wrangler deploy` creates from the `migrations` in `wrangler.jsonc`.

**Custom domain:** bind a Workers Custom Domain in the dashboard and use it for `BETTER_AUTH_URL`. Worth doing even if `workers.dev` is fine: **the Cache API is a silent no-op on `*.workers.dev`**, so the edge cache in front of the token catalogue and search never hits and more requests go to CoinGecko. In `wrangler tail`, only ever seeing `edge cache: stored` (never `edge cache: hit`) means the cache isn't in effect.

## Verify

1. Open the URL → sign up → you land on the overview.
2. Add a manual account → Sync now → it appears with a total. Optionally add an EVM wallet (no key needed).
3. `pnpm exec wrangler tail` shows structured JSON lines. Crons: hourly sync sweep (`30 * * * *` UTC) and daily jobs (`0 23 * * *` UTC). Triggering the hourly one from the dashboard (Workers → folio → Triggers) logs `cron sweep enqueued`, then `job done` / `account synced` per job and `queued round done` per portfolio.
4. Jobs that fail their last retry are buried in the runner's storage for 7 days and logged as `job failed on final attempt, burying it`.
5. Check Durable Object CPU with `pnpm perf:cpu:online` (or Workers Logs for `JobRunner` alarms): `exceededCpu` means the free plan's DO CPU limit is lower than documented.

## Updating

```sh
cd apps/web
# if the schema changed: pnpm --filter @folio/db db:generate, then
pnpm exec wrangler d1 migrations apply folio --remote
pnpm run deploy
```

## Auto-deploy on tag

`.github/workflows/deploy.yml` deploys on a `v*` tag push; `main` never reaches production by itself.

One-time setup: create a Cloudflare API token with **Workers Scripts → Edit** and **D1 → Edit**, and add it as the repo secret `CLOUDFLARE_API_TOKEN` (repo-level, so the preview workflows can read it too). Runtime secrets stay on the Worker; CI never handles them.

A tag re-runs the CI gates, **applies remote migrations, then deploys** (fail-stop: a failed migration skips the deploy), then creates a GitHub Release.

```sh
git tag v1.2.0 && git push origin v1.2.0
```

From a phone: Actions → Deploy → Run workflow with a version like `v1.2.1`; the bot creates the tag. If a tag protection ruleset covers `v*`, add `github-actions` to its bypass list or the push is rejected (403).

> **Remote D1 migrations are irreversible.** Additive ones are safe to auto-apply; review any destructive migration before tagging. To require approval, add required reviewers to the `production` environment.

## Global token map refresh (daily)

`.github/workflows/ref-index-refresh.yml` refreshes `global_token_ref_index` daily at 23:00 UTC (plus manual runs; tick *dry run* for counts only). It runs `scripts/ref-index/refresh.ts` on a GitHub runner against the production D1 via the REST API, because the diff costs far more CPU than a Worker invocation allows.

- Uses the same `CLOUDFLARE_API_TOKEN`; optional repo secret `COINGECKO_API_KEY`.
- GitHub schedules are best-effort (often late) and pause after 60 days without a commit on a public repo — re-enable on the workflow page.
- Locally: `pnpm --filter @folio/web ref-index:refresh` (`--dry-run`, `--env preview`); `ref-index:local` fills the `pnpm dev` database.
- A run ends with `rows` / `skipped` / `inserted` / `updated` / `deleted`; steady state is near 0 changes. `unmatchedPlatforms` > 0 is a warning (a chain whose coins will have no price).

## PR previews (label `preview`)

`.github/workflows/pr-preview.yml` uploads a labeled PR as a version of a separate Worker, `folio-preview`, at `https://pr-<N>-folio-preview.<subdomain>.workers.dev`, and comments the URL on the PR. Every push updates it while the label is on. `preview-main.yml` deploys `main` to the same Worker's active deployment (the fixed preview domain = staging). All previews share one Worker and one `folio-preview` D1, whose data and migrations persist across PRs.

Config that must stay right (a preview once overwrote production):

- `env.preview` sets `"name": "folio-preview"` — without it `--env preview` deploys over the production `folio` Worker.
- Preview builds use `CLOUDFLARE_ENV=preview` at **build** time; with `@cloudflare/vite-plugin`, `--env` at deploy time is ignored. Check `dist/server/wrangler.json` shows `folio-preview`.
- Preview logins use email/password: `PREVIEW_TRUSTED_ORIGINS` lets better-auth accept the alias hosts (never set it in production); passkeys don't work across aliases.

One-time setup:

```sh
cd apps/web
# 1. Create the preview D1; paste its database_id into wrangler.jsonc → env.preview.d1_databases[0]
pnpm exec wrangler d1 create folio-preview

# 2. Secrets: use --name folio-preview, NOT --env preview (that resolves to folio-preview-preview).
#    Mirror the full production set — a partial set fails silently at sync time.
pnpm exec wrangler secret put SECRETS_KEY        --name folio-preview
pnpm exec wrangler secret put BETTER_AUTH_SECRET --name folio-preview
pnpm exec wrangler secret put BETTER_AUTH_URL    --name folio-preview   # the fixed preview domain; set before the first sign-up
pnpm exec wrangler secret put COINSTATS_API_KEY  --name folio-preview
pnpm exec wrangler secret put COINGECKO_API_KEY  --name folio-preview
pnpm exec wrangler secret put ZERION_API_KEY     --name folio-preview
pnpm exec wrangler secret put BINANCE_API_BASE   --name folio-preview   # Binance 403s Cloudflare IPs without these three proxy bases
pnpm exec wrangler secret put BINANCE_FAPI_BASE  --name folio-preview
pnpm exec wrangler secret put BINANCE_DAPI_BASE  --name folio-preview
```

**Reset** (only when a destructive migration from one PR broke another's preview): run `.github/workflows/preview-reset.yml` from Actions and type `RESET`. It drops every table in `folio-preview` and re-applies all migrations; it never touches production. The drop-all script hasn't been verified against real D1 — if it fails, `wrangler d1 delete folio-preview`, `d1 create folio-preview`, paste the new id, and `pnpm run db:migrate:preview`.

## Notes

- Production logs are JSON Lines in Workers Logs (Dashboard → Observability, 7-day retention). Set verbosity with `LOG_LEVEL`; `LOG_PRETTY` is for local dev only.
- Rotate a secret with another `wrangler secret put <NAME>`. Secrets never go in git.
