# Folio — Engineering Conventions

> **Folio** is a self-hosted crypto portfolio tracker (on-chain wallets + CEX + perp DEX + manual assets → one dashboard). M1–M6 are complete and archived under [evolution/milestones/](evolution/milestones/) (blueprint `arch-design.md` + per-phase log `checklist.md` + `plans/`). Forward work lives in [evolution/roadmap.md](evolution/roadmap.md), with new plans in `evolution/plans/`. Read this file first every session, do only the current phase, then update its entry in the relevant log and stop. Coding conventions (imports, naming, UI, React, tests, commits): see [CODING.md](CODING.md).

## Tech stack
- TanStack Start (`@tanstack/react-start`) + Vite — full-stack, server functions
- Cloudflare Workers runtime; Cloudflare D1 (SQLite) + Drizzle ORM
- better-auth (Drizzle adapter) for auth
- pnpm workspace monorepo; TypeScript strict
- Vitest (test-first); Wrangler for deploy

## Core principles (non-negotiable)
Architecture & security principles (1–6) live here; coding-style principles (7–12) are kept as numbered anchors — full text in **[CODING.md](CODING.md)**.

1. **Contract-first** — define types & the `BalanceProvider` interface before implementations. Every provider implements the same interface.
2. **Test-first** — each provider adapter gets tests against recorded fixtures before its implementation. Parsing logic must have golden tests.
3. **Modular** — each provider is an independent package (`@folio/provider-*`, own package.json), interdependency-free, composed via the shared interface. UI lives in `@folio/ui`.
4. **Tests beside src** — each package's tests go in `tests/` (sibling of `src/`); provider API fixtures in `tests/fixtures/`.
5. **Secrets never leave / never echoed** — APIs never return credential values; only a safe projection (`safeView`: public whole, semi masked, secret dropped) + `needsCredentials`. Per-account creds are one `creds` map, encrypted **per field by `type`** — only `secret` fields AES-GCM-encrypted (Web Crypto, `SECRETS_KEY` from env); `public`/`semi` plaintext (P6.6.1). **creds shaping lives in the app** (`apps/web/src/lib/creds.ts`: seal/open/safeView/isComplete/categorize), driven by `@folio/balances`'s `credentialSpecs()` field `type`s + Web Crypto — `@folio/balances` only does provider-facing work (`validateCredentials`/`fetchBalances`) and never sees `SECRETS_KEY`.
6. **`@folio/db` exposes only wrapped ops** — no Drizzle instance / schema handle exported; only userId-scoped domain functions. All data access funnels through here.
7. **Relative imports without extensions** (`moduleResolution: bundler`).
8. **No hardcoding** — magic numbers named; volatile/env-specific → env, stable domain → each package's `constants.ts`.
9. **Prefer mature, vetted libraries** — must pass the 4 gates (CF Workers, maintained, complexity-worth-it, no conflicts); record the choice.
10. **kebab-case filenames**; exports keep their own case convention (components `PascalCase`, funcs `camelCase`, types `PascalCase`, constants `UPPER_SNAKE`).
11. **UI = beUI (Framer Motion) 动效层 + 少量手搓本地原语,皆经 shadcn registry — 绝不 Radix** — beUI 件经 `@beui/*` registry(`pnpm dlx shadcn add @beui/<name>`)落 `packages/ui/src/components/motion/`,beUI 无对应的基础件(Card/Avatar/Separator/Skeleton)手搓;迁移中残留的 base-vega(Base UI)件正逐步退场,终态移除 `@base-ui/react`(见 [ADR 0004](docs/adr/0004-adopt-beui-motion-layer-drop-base-ui.md))。design tokens 优先(含 `lib/ease.ts` 动效 spring/easing token),避免任意值,不改件内核。
12. **Small commits, English messages — never `git commit` without explicit approval** ("提交"/"commit" authorizes it; "执行"/"go" does NOT).

## Package conventions (monorepo)
- **Packages are created on-demand by the phase that needs them** — not pre-stubbed. P1.2 creates `packages/core`, P1.4 `packages/db`, P1.5 `packages/ui`, each provider when built. The workspace globs in `pnpm-workspace.yaml` already cover `packages/*`, `packages/providers/*`, `apps/*`, so new packages need no config change.
- **Internal-packages pattern**: each `@folio/*` package.json sets `"exports": { ".": "./src/index.ts" }` pointing at source — **no build step** for internal libs (Vite/Vitest transpile TS directly). Consumers depend via `"@folio/<x>": "workspace:*"`.
- **No TS project references** (overkill here); each package `tsconfig.json` just extends `../../tsconfig.base.json`.
- **Each package ships its own minimal `vitest.config.ts`** + a `test: "vitest run"` script. This keeps `vitest` from inheriting the root `projects` config when run inside a package, and lets the root runner (`pnpm test:packages`) discover the package. The root `vitest.config.ts` (`test.projects`) is the canonical all-package runner.
- **A provider serving multiple account types**: keep `BalanceProvider.accountType` singular; use a factory to emit one provider object per type (shared impl), export `providers: BalanceProvider[]`, and let `@folio/sync` flatten them into `buildRegistry`. See arch-design.md §2 (方案 A).
- Package prefix `@folio/*`. Providers published as `@folio/provider-<name>`.

## Toolchain notes (current best practices — supersede older wording in arch-design.md)
- **`wrangler.jsonc`** (not `wrangler.toml`) — Cloudflare's recommended format; some features JSON-only. Wrangler v4.
- **Vitest 4** with root `test.projects` in `vitest.config.ts` (`vitest.workspace.ts` is removed in v4). Glob `test.projects` at each package's **config file** (`packages/**/vitest.config.ts`), not at directories — a dir glob (`packages/*`, `packages/tokens/*`) also matches container-only folders (`packages/tokens`, `packages/providers`), which get picked up as unnamed, colliding projects and fail the whole run.
- **Cloudflare targeting via `@cloudflare/vite-plugin`** (not the legacy Nitro `cloudflare-module` preset).
- Package name is **`@tanstack/react-start`** (the old `@tanstack/start` is gone).
- TypeScript: `module: preserve` + `moduleResolution: bundler` (now the modern defaults) enable extension-less relative imports.
- **D1 testing**: `@cloudflare/vitest-pool-workers` 0.16.x — use the root `cloudflareTest` plugin + `readD1Migrations` (the old `defineWorkersConfig`/`/config` subpath is removed); `env`/`applyD1Migrations` from `cloudflare:test`; `Cloudflare.Env` augmentation in a test `env.d.ts`. This version doesn't isolate per-test storage → reset state in `beforeEach`.
- **D1 data layer**: D1 has no interactive `db.transaction()` → atomic multi-writes use `db.batch([...])`. D1 enforces FKs, so `ON DELETE CASCADE` works at runtime. Migrations: `drizzle-kit generate` (out=`drizzle/`) → apply (never `drizzle-kit migrate`); `out` == wrangler `migrations_dir` == test `readD1Migrations` path. **Applying**: migrate scripts live in **`apps/web`** (it owns the real `database_id` + `DB` binding + `migrations_dir`): `pnpm --filter @folio/web db:migrate:local` after a schema change, `db:migrate:remote` before deploy. **Must run from `apps/web`, not `packages/db`**: `packages/db/wrangler.jsonc` has a placeholder `database_id` + its own `.wrangler` (Vitest/Miniflare only), so an apply there hits the wrong DB — `--local` writes `packages/db/.wrangler` (≠ the running server's `apps/web/.wrangler`), `--remote` targets a bogus id. `@cloudflare/vite-plugin` *may* auto-apply `drizzle/` on dev-server startup but is unreliable across new migrations → after a schema change run `db:migrate:local` (Miniflare targets by `database_name` → the running server's local D1). `db:generate` stays in `packages/db` (schema owner). Tests apply via `readD1Migrations`, independent of both. **Column renames need a TTY**: `drizzle-kit generate` prompts "created or renamed?" per column and hard-errors headless (no TTY) — drive it with `expect` (spawn `pnpm db:generate`, on each "created or renamed from another column" send down-arrow `\033[B` + `\r` to pick "rename column"). Renaming a PK column → SQLite can't `ALTER`, so drizzle emits create-new-table + `INSERT…SELECT` + drop + rename (data preserved); a non-PK column gets a plain `RENAME COLUMN`.
- TS6 generic `Uint8Array<ArrayBufferLike>` isn't assignable to Web Crypto `BufferSource`/`D1` BufferSource — annotate byte arrays as `Uint8Array<ArrayBuffer>` when needed.
- **better-auth on CF Workers** (1.6+): native `node:crypto` scrypt is auto-selected with `nodejs_compat` — no hash override needed (supersedes arch-design §7.1 ①). Build the auth instance lazily (`env` from `cloudflare:workers`), never at module load. `@better-auth/cli` (1.4.x) lags better-auth (1.6.x) and fails under this repo's jiti (pulls a stale `better-call`) → define the Drizzle auth schema by hand per the official spec. Verify auth via curl with an `Origin: http://localhost:3000` header (CSRF guard).
- **TanStack Start server routes**: `createFileRoute("/path/$").server.handlers` (GET/POST → `Response`). The `server` option is a Start augmentation of `@tanstack/router-core`; since app `src` doesn't import `@tanstack/react-start`, add `/// <reference types="@tanstack/react-start" />` (in `src/env.d.ts`) so `tsc` sees it. Run `wrangler types` after editing `wrangler.jsonc` bindings → `worker-configuration.d.ts` (Biome-excluded).
- **Lint/format = Biome** (`biome.json`, 2.x): `pnpm lint` (check) / `pnpm lint:fix` (write); CI runs `biome ci`. Style: 2-space, double quotes, lineWidth 100. Excludes vendored/generated (shadcn `components/`+`styles/`, `routeTree.gen.ts`, `drizzle/`, all `*.css`); `.gitignore` reused via `vcs.useIgnoreFile`. `noNonNullAssertion` is off in test files only. No ESLint (no type-aware lint yet; `tsc --strict` covers types).

## Security model (see arch-design.md §3, §7.1)
- Global provider keys (`ZERION_API_KEY`, etc.) → CF Secret/env. Per-account creds → D1 as one `creds` map (physical column `enc_credentials`), encrypted **per field by `type`**: `secret` fields AES-GCM with `SECRETS_KEY`, `public`/`semi` plaintext (P6.6.1/P6.6.2; seal/open/safeView/isComplete now in `apps/web/src/lib/creds.ts`, driven by `@folio/balances` `credentialSpecs()` + Web Crypto).
- Read-only tracking, **no signing** → no private-key field in any `provider.inputs`; on-chain accounts store address/xpub only (`public`).
- Decrypt (`openCreds`) only inside server functions / sync at fetch time, discard immediately, never log (P6.7 red line: log only accountId/type/code/counts).
- better-auth CF gotchas (apply in P2.1): native `node:crypto` scrypt hash override; single module-level auth instance; `ctx.waitUntil` for background tasks; secondaryStorage TTL ≥ 60s; disable cookieCache; no auth calls at module load.

---

## Progress

**M1–M6 complete** — foundation → on-chain → CEX → perp → polish, deploy-ready (see [apps/web/DEPLOY.md](apps/web/DEPLOY.md); going live is user-run per safety rules). Full per-phase archive (what/why/tests/gates) in **[evolution/milestones/](evolution/milestones/)** (`checklist.md` + `arch-design.md` + `plans/`).

Forward work — deferred features + the M7+ roadmap — lives in **[evolution/roadmap.md](evolution/roadmap.md)**; per-phase tracking in **[evolution/checklist.md](evolution/checklist.md)**; new plans go in `evolution/plans/`.

---

## Agent skills

Per-repo config for the engineering skills (set up by `setup-matt-pocock-skills`).

### Issue tracker

GitHub Issues (repo `x0finch/folio2`), via the `gh` CLI. External PRs are **not** a triage surface. See [docs/agents/issue-tracker.md](docs/agents/issue-tracker.md).

### Triage labels

Five canonical roles, default names: `needs-triage` / `needs-info` / `ready-for-agent` / `ready-for-human` / `wontfix` (created on first use). See [docs/agents/triage-labels.md](docs/agents/triage-labels.md).

### Domain docs

Single-context: one `CONTEXT.md` + `docs/adr/` at the repo root. See [docs/agents/domain.md](docs/agents/domain.md).
