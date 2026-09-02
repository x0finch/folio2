# Deploying Folio to Cloudflare Workers (self-host)

Folio runs on Cloudflare Workers + D1. This is a one-time setup; afterwards `pnpm run deploy` ships updates.

**Prerequisites:** a Cloudflare account; this repo cloned with `pnpm install` done (Wrangler is a dev dependency). Run everything below from `apps/web/`.

## What you provide (secrets)

Production needs **4 secrets** + 1 plaintext var (already in `wrangler.jsonc`: `LOG_LEVEL=info`).
Generate the two random ones locally:

```sh
openssl rand -base64 32   # → SECRETS_KEY      (AES-GCM key; encrypts the `secret` creds fields)
openssl rand -hex 32      # → BETTER_AUTH_SECRET (session signing)
```

`COINSTATS_API_KEY` (free: openapi.coinstats.app) is the only on-chain provider key you need — Solana/Sui/Cosmos. **EVM needs no key** (Rabby) and neither does Bitcoin (public Blockbook). `ZERION_API_KEY` (free tier: developers.zerion.io) is optional: Zerion is kept as an alternate EVM source, not the default. `BETTER_AUTH_URL` is your deployed origin (set after step 5).

> Exchange API keys (Binance/OKX) are **not** deployment config — you enter them per-account in the UI; they're encrypted into D1. Only the 4 secrets below are env.

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
pnpm exec wrangler secret put COINSTATS_API_KEY
pnpm exec wrangler secret put BETTER_AUTH_URL    # placeholder for now (e.g. https://example.com); fixed in step 6
# Optional — token prices/logos (CoinGecko). Works without a key on the free tier (low rate limit);
# set one (demo/pro) to lift limits. Skip this line to run keyless.
pnpm exec wrangler secret put COINGECKO_API_KEY

# 5. Build + deploy (the `deploy` script runs `vite build` then `wrangler deploy`)
pnpm run deploy
# → note the printed URL, e.g. https://folio-web.<your-subdomain>.workers.dev

# 6. better-auth needs BETTER_AUTH_URL to match the real origin → set it and redeploy
pnpm exec wrangler secret put BETTER_AUTH_URL     # the workers.dev URL from step 5
pnpm run deploy
```

**Custom domain:** bind a Workers Custom Domain in the Cloudflare dashboard, then use that domain for `BETTER_AUTH_URL` in step 6.

Worth doing even if the workers.dev URL is fine for you: **the Cache API only works on a custom
domain.** On `*.workers.dev` every `cache.put`/`cache.match` is a silent no-op ([Cloudflare
docs](https://developers.cloudflare.com/workers/runtime-apis/cache/)) — the cache in front of the
token catalogue and token search (`src/lib/server/tokens/edge-cache.ts`, used by `catalogue.ts`/`list.ts`) never hits, so both fall through to
CoinGecko more often than they need to. Nothing breaks; it just costs extra upstream calls. To
check which side you are on, look for `edge cache: hit` in `wrangler tail` — only ever seeing
`edge cache: stored` means it is not in effect.

## Verify

1. Open the URL → **sign up** → you land on the overview.
2. Add a **manual** account (symbol/amount/usd) → **Sync now** → it appears with a total.
3. (Optional) add an on-chain wallet (EVM needs no key) → Sync.
4. Logs: `pnpm exec wrangler tail` — structured JSON lines (`account synced` with `userId`/`accountId`/`type`, etc.). The daily cron (`0 0 * * *` UTC) auto-runs; trigger it manually from the dashboard (Workers → folio-web → Triggers / Cron) to see a `cron sweep done` line.

## Updating later (manual)

```sh
cd apps/web
# if schema changed: pnpm --filter @folio/db exec drizzle-kit generate, then:
pnpm exec wrangler d1 migrations apply folio --remote
pnpm run deploy
```

## Auto-deploy (CI, on tag)

`.github/workflows/deploy.yml` deploys on a `v*` tag push (e.g. `v1.2.0`). `main` never
touches production on its own — you tag a release when you want to ship.

**One-time setup:**

1. Create a Cloudflare API token (Dashboard → My Profile → API Tokens → Create Token).
   Permissions: **Account → Workers Scripts → Edit** and **Account → D1 → Edit**.
2. Add it as a repo secret named **`CLOUDFLARE_API_TOKEN`** (Settings → Secrets and variables
   → Actions). That's the only secret CI needs — `account_id` lives in `wrangler.jsonc`, and
   the Worker's runtime secrets (`SECRETS_KEY`, `BETTER_AUTH_SECRET`, …) are already set on the
   Worker via `wrangler secret put`; CI never handles them.

**What a tag does:** re-runs the four gates (safety net), then **applies remote D1 migrations,
then deploys** — in that order, fail-stop. If the migration fails the deploy is skipped, so you
never end up with new code against an un-migrated schema.

```sh
git tag v1.2.0 && git push origin v1.2.0   # → CI migrates remote D1, then deploys
```

> ⚠️ **Remote D1 migrations are irreversible.** Additive migrations (new tables/columns) are
> safe to auto-apply; a destructive one (dropping a column, etc.) would hit production with no
> rollback. Review the pending migration before tagging. To gate deploys behind manual approval,
> add **required reviewers** to the `production` environment (repo Settings → Environments) —
> the workflow already targets it and will then wait for an approval before migrating/deploying.

## PR preview (CI, on demand via label)

`.github/workflows/pr-preview.yml` deploys a **preview** of a PR to a separate Worker `folio-preview`
(a different Worker from production `folio` — production is never touched), and posts the URL back as
a sticky PR comment. It reuses the same `CLOUDFLARE_API_TOKEN` as the tag deploy; no new token needed.

**Opt-in per PR:** it only runs when the PR carries the **`preview`** label — nothing deploys
automatically on open. Add the label = "I want a preview of this PR"; while it's labeled, every push
updates the preview; remove the label and it stops. (Create a `preview` label the first time straight
from the PR's Labels box.)

**How it's shaped (chosen deliberately):**

- **One shared preview Worker + one shared preview D1 (`folio-preview`).** All labeled PRs deploy to
  the same Worker; the last push wins (the workflow serializes deploys via `concurrency`). The URL is
  therefore **fixed**: `https://folio-preview.<your-subdomain>.workers.dev`.
- **The preview DB is not reset on every deploy** — it keeps its data/login across PRs (so you can
  sign up a test user once and keep using it). Migrations **accumulate** onto it, applied before each
  deploy with the same fail-stop order as production.
- **Additive migrations** (new table/column) accumulate harmlessly. **Destructive migrations**
  (drop/rename a column) are the one hazard of a shared DB: a migration from PR-A drops a column,
  then a PR that doesn't have that migration renders against a DB that lost it → that preview breaks,
  and D1 has no down-migration to roll back. When that happens, run the manual reset below.

**Critical config (learned the hard way — a preview deploy once clobbered production):**

- **`env.preview` must set `"name": "folio-preview"`.** Wrangler v4 removed service environments; an
  env without its own `name` falls back to the top-level `folio`, so `wrangler deploy --env preview`
  overwrites the **production** Worker instead of a separate one.
- **`deploy:preview` must build with `CLOUDFLARE_ENV=preview`.** With `@cloudflare/vite-plugin`,
  `wrangler deploy` ships the *build artifact's* config — `--env` at deploy time is a no-op. The env is
  picked at **build** time via `CLOUDFLARE_ENV` (same mechanism as e2e's `CLOUDFLARE_ENV=test`). Verify:
  after `CLOUDFLARE_ENV=preview pnpm build`, `dist/server/wrangler.json` should show `name`/`d1` as
  `folio-preview`.
- **`CLOUDFLARE_API_TOKEN` must be a repo-level secret**, not only the `production` environment secret
  the tag deploy uses — `pr-preview.yml` declares no `environment:`, so it reads the repo-level one.
- `wrangler secret put --env preview` **does** target `folio-preview` correctly even without the `name`
  above (secret put keeps the legacy `-preview` suffix); only `deploy` needed the two fixes.

**One-time setup:**

```sh
cd apps/web
# 1. Create the preview D1, then paste the printed database_id into
#    wrangler.jsonc → env.preview.d1_databases[0].database_id (replacing the REPLACE_WITH_… placeholder)
pnpm exec wrangler d1 create folio-preview

# 2. Set the preview Worker's secrets (its own set — independent from production; generate fresh).
#    BETTER_AUTH_URL must be the fixed preview URL so better-auth stays same-origin.
pnpm exec wrangler secret put SECRETS_KEY        --env preview   # openssl rand -base64 32
pnpm exec wrangler secret put BETTER_AUTH_SECRET --env preview   # openssl rand -hex 32
pnpm exec wrangler secret put BETTER_AUTH_URL    --env preview   # https://folio-preview.<your-subdomain>.workers.dev
pnpm exec wrangler secret put COINSTATS_API_KEY  --env preview   # set if you want on-chain sync to work in previews
# COINGECKO_API_KEY optional (works keyless on the free tier)
```

You get the exact `<your-subdomain>` from the first deploy's printed URL (or the tag deploy's).
Set `BETTER_AUTH_URL` **before** the first preview sign-up (WebAuthn RP is derived from it). No
`production` environment / approval gate applies to previews — they deploy on every PR push.

> On `*.workers.dev` the Cache API is a silent no-op (same as the workers.dev note above), so
> logo/token caching doesn't take effect in previews — functionally fine, just extra upstream calls.

**Manual reset (rare — only when a destructive migration broke a preview):**
`.github/workflows/preview-reset.yml`, run from the Actions tab (`workflow_dispatch`, type `RESET` to
confirm). It **wipes all data in `folio-preview`** (drops every table + clears `d1_migrations`), then
re-applies all migrations from scratch. It only ever touches `folio-preview`, never production.

> ⚠️ The reset's drop-all (`scripts/reset-preview-db.mjs`) has **not yet been verified against a real
> D1**. On the first run, watch the logs: confirm the drop step doesn't error on FK/PRAGMA behavior,
> and that `wrangler … --json` output parsed cleanly. **Manual fallback if it fails:**
> `pnpm exec wrangler d1 delete folio-preview` then `d1 create folio-preview`, paste the **new**
> `database_id` into `wrangler.jsonc` env.preview, and `pnpm run db:migrate:preview`.

## Notes

- **Local vs remote D1 are separate.** `pnpm dev` uses a local SQLite file; production uses the remote D1. Always `migrations apply … --remote` after a schema change.
- **Logging:** production emits JSON Lines into **Workers Logs** (Dashboard → Observability, queryable; 7-day retention). `LOG_PRETTY` is intentionally unset in prod (it's local-dev only). Adjust verbosity via the `LOG_LEVEL` var in `wrangler.jsonc`.
- **Secrets** are encrypted and only exist in the deployed Worker; rotate with another `wrangler secret put <NAME>`. They are never in git.
- **Rolling back past the precompute rename (FOL-36) needs one manual cleanup.** The home
  overview, tab strip and both 24h-gain endpoints read values stored under `pc1:*` keys in
  `user_cache`, and "is this value still valid?" is decided by a watermark key in the same
  family. The previous release used `gain24h:*` values with a `gain24h-mark*` watermark, and the
  two generations do not touch each other — which is what makes rolling *forward* safe. Rolling
  **back** is the direction that bites: the old code resumes reading `gain24h:*` values that are
  up to 90 minutes old, against a watermark no write has bumped since the upgrade, so every one
  of them looks fresh. Any account change made while the new version was live is invisible in
  those numbers until the TTL runs out. Clear them by hand right after rolling back:

  ```sh
  wrangler d1 execute folio --remote \
    --command "DELETE FROM user_cache WHERE k LIKE 'gain24h%'"
  ```

  (Deleting cache rows is always safe — worst case the next page load is a little slower. The
  `pc1:*` rows can be left alone; they cost a few KB and expire on their own.)
