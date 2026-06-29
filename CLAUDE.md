# Folio — Engineering Conventions

> **Folio** is a self-hosted crypto portfolio tracker (on-chain wallets + CEX + perp DEX + manual assets → one dashboard). M1–M6 are complete and archived under [evolution/milestones/](evolution/milestones/) (blueprint `arch-design.md` + per-phase log `checklist.md` + `plans/`). Forward work lives in [evolution/roadmap.md](evolution/roadmap.md), with new plans in `evolution/plans/`. Read this file first every session, do only the current phase, then update its entry in the relevant log and stop.

## Tech stack
- TanStack Start (`@tanstack/react-start`) + Vite — full-stack, server functions
- Cloudflare Workers runtime; Cloudflare D1 (SQLite) + Drizzle ORM
- better-auth (Drizzle adapter) for auth
- pnpm workspace monorepo; TypeScript strict
- Vitest (test-first); Wrangler for deploy

## Core principles (non-negotiable)
1. **Contract-first** — define types & the `BalanceProvider` interface before implementations. Every provider implements the same interface.
2. **Test-first** — each provider adapter gets tests against recorded fixtures before its implementation. Parsing logic must have golden tests.
3. **Modular** — each provider is an independent package (`@folio/provider-*`, own package.json), interdependency-free, composed via the shared interface. UI lives in `@folio/ui`.
4. **Tests beside src** — each package's tests go in `tests/` (sibling of `src/`); provider API fixtures in `tests/fixtures/`.
5. **Secrets never leave / never echoed** — APIs never return credential values; only a safe projection (`safeView`: public whole, semi masked, secret dropped) + `needsCredentials`. Per-account creds are one `creds` map, encrypted **per field by `type`** — only `secret` fields AES-GCM-encrypted (Web Crypto, `SECRETS_KEY` from env); `public`/`semi` plaintext (P6.6.1).
6. **`@folio/db` exposes only wrapped ops** — no Drizzle instance / schema handle exported; only userId-scoped domain functions. All data access funnels through here.
7. **Relative imports without extensions** — `moduleResolution: bundler` workspace-wide; write `import './foo'`, never `./foo.js` or `./foo.ts`.
8. **No hardcoding** — chain IDs, RPCs, API bases, gap limits, derivation paths, timeouts, concurrency, TTLs → config/constants/env. Magic numbers must be named. Volatile env-specific values → env; stable domain constants → each package's `constants.ts`.
9. **Prefer mature, vetted libraries** — before each phase ask if a widely-adopted lib/standard exists (signing, BIP32, crypto, dates, decimals — don't hand-roll). A library must pass 4 gates or be rejected: ① runs on CF Workers (no Node-native deps, reasonable size); ② actively maintained, no known severe CVEs; ③ complexity matches payoff; ④ no conflicting transitive deps. Record the choice (what/why/rejected) in the commit or here.
10. **kebab-case filenames; exports keep their own convention** — files/dirs lowercase-hyphenated (`balance-table.tsx`, `create-account.ts`), decoupled from export names. Exports: React components PascalCase, functions/vars camelCase, types/interfaces PascalCase, constants UPPER_SNAKE.
11. **UI = shadcn design system only** — colors/spacing/radius/fonts via shadcn design tokens (CSS vars: `bg-background`, `text-foreground`, `border-border`, …). No hardcoded color values, no arbitrary-value classes (`bg-[#...]`, `p-[13px]`), no editing component internals. New visuals = compose existing shadcn components or adjust theme tokens.
    - **Base components are added via `shadcn add`, never hand-written.** Run `pnpm dlx shadcn@latest add <comp>` (monorepo-aware: primitives land in `@folio/ui`, blocks in `apps/web`) and export from `@folio/ui/src/index.ts`. Only **app-level compositions** (`apps/web/src/components/`) are authored by hand, by composing `@folio/ui` primitives. Do not transcribe shadcn source manually.
    - **Vendored shadcn components are not unit-tested** (they're upstream-maintained source). Validate the integration instead — the apps/web build must emit their utility classes (cross-package `@source`). Write tests for our own logic (app compositions, hooks), not for `@folio/ui` primitives.
12. **Small commits, English messages** — commit each acceptance-worthy unit; the message ties contract/test/impl together. **Commit messages are written in English** (planning/discussion happens in Chinese, but the git history stays English). Conventional-commit style: `type(scope): summary`.

## Package conventions (monorepo)
- **Packages are created on-demand by the phase that needs them** — not pre-stubbed. P1.2 creates `packages/core`, P1.4 `packages/db`, P1.5 `packages/ui`, each provider when built. The workspace globs in `pnpm-workspace.yaml` already cover `packages/*`, `packages/providers/*`, `apps/*`, so new packages need no config change.
- **Internal-packages pattern**: each `@folio/*` package.json sets `"exports": { ".": "./src/index.ts" }` pointing at source — **no build step** for internal libs (Vite/Vitest transpile TS directly). Consumers depend via `"@folio/<x>": "workspace:*"`.
- **No TS project references** (overkill here); each package `tsconfig.json` just extends `../../tsconfig.base.json`.
- **Each package ships its own minimal `vitest.config.ts`** + a `test: "vitest run"` script. This keeps `vitest` from inheriting the root `projects` config when run inside a package, and lets the root runner (`pnpm test:packages`) discover the package. The root `vitest.config.ts` (`test.projects`) is the canonical all-package runner.
- **A provider serving multiple account types**: keep `BalanceProvider.accountType` singular; use a factory to emit one provider object per type (shared impl), export `providers: BalanceProvider[]`, and let `@folio/sync` flatten them into `buildRegistry`. See arch-design.md §2 (方案 A).
- Package prefix `@folio/*`. Providers published as `@folio/provider-<name>`.

## Toolchain notes (current best practices — supersede older wording in arch-design.md)
- **`wrangler.jsonc`** (not `wrangler.toml`) — Cloudflare's recommended format; some features JSON-only. Wrangler v4.
- **Vitest 4** with root `test.projects` in `vitest.config.ts` (`vitest.workspace.ts` is removed in v4).
- **Cloudflare targeting via `@cloudflare/vite-plugin`** (not the legacy Nitro `cloudflare-module` preset).
- Package name is **`@tanstack/react-start`** (the old `@tanstack/start` is gone).
- TypeScript: `module: preserve` + `moduleResolution: bundler` (now the modern defaults) enable extension-less relative imports.
- **D1 testing**: `@cloudflare/vitest-pool-workers` 0.16.x — use the root `cloudflareTest` plugin + `readD1Migrations` (the old `defineWorkersConfig`/`/config` subpath is removed); `env`/`applyD1Migrations` from `cloudflare:test`; `Cloudflare.Env` augmentation in a test `env.d.ts`. This version doesn't isolate per-test storage → reset state in `beforeEach`.
- **D1 data layer**: D1 has no interactive `db.transaction()` → atomic multi-writes use `db.batch([...])`. D1 enforces FKs, so `ON DELETE CASCADE` works at runtime. Migrations: `drizzle-kit generate` (out=`drizzle/`) → `wrangler d1 migrations apply` (never `drizzle-kit migrate`); `out` == wrangler `migrations_dir` == test `readD1Migrations` path.
- TS6 generic `Uint8Array<ArrayBufferLike>` isn't assignable to Web Crypto `BufferSource`/`D1` BufferSource — annotate byte arrays as `Uint8Array<ArrayBuffer>` when needed.
- **better-auth on CF Workers** (1.6+): native `node:crypto` scrypt is auto-selected with `nodejs_compat` — no hash override needed (supersedes arch-design §7.1 ①). Build the auth instance lazily (`env` from `cloudflare:workers`), never at module load. `@better-auth/cli` (1.4.x) lags better-auth (1.6.x) and fails under this repo's jiti (pulls a stale `better-call`) → define the Drizzle auth schema by hand per the official spec. Verify auth via curl with an `Origin: http://localhost:3000` header (CSRF guard).
- **TanStack Start server routes**: `createFileRoute("/path/$").server.handlers` (GET/POST → `Response`). The `server` option is a Start augmentation of `@tanstack/router-core`; since app `src` doesn't import `@tanstack/react-start`, add `/// <reference types="@tanstack/react-start" />` (in `src/env.d.ts`) so `tsc` sees it. Run `wrangler types` after editing `wrangler.jsonc` bindings → `worker-configuration.d.ts` (Biome-excluded).
- **Lint/format = Biome** (`biome.json`, 2.x): `pnpm lint` (check) / `pnpm lint:fix` (write); CI runs `biome ci`. Style: 2-space, double quotes, lineWidth 100. Excludes vendored/generated (shadcn `components/`+`styles/`, `routeTree.gen.ts`, `drizzle/`, all `*.css`); `.gitignore` reused via `vcs.useIgnoreFile`. `noNonNullAssertion` is off in test files only. No ESLint (no type-aware lint yet; `tsc --strict` covers types).

## Security model (see arch-design.md §3, §7.1)
- Global provider keys (`ZERION_API_KEY`, etc.) → CF Secret/env. Per-account creds → D1 as one `creds` map (physical column `enc_credentials`), encrypted **per field by `type`**: `secret` fields AES-GCM with `SECRETS_KEY`, `public`/`semi` plaintext (P6.6.1/P6.6.2; `@folio/core` creds.ts).
- Read-only tracking, **no signing** → no private-key field in any `provider.inputs`; on-chain accounts store address/xpub only (`public`).
- Decrypt (`openCreds`) only inside server functions / sync at fetch time, discard immediately, never log (P6.7 red line: log only accountId/type/code/counts).
- better-auth CF gotchas (apply in P2.1): native `node:crypto` scrypt hash override; single module-level auth instance; `ctx.waitUntil` for background tasks; secondaryStorage TTL ≥ 60s; disable cookieCache; no auth calls at module load.

---

## Progress

**M1–M6 complete** — foundation → on-chain → CEX → perp → polish, deploy-ready (see [apps/web/DEPLOY.md](apps/web/DEPLOY.md); going live is user-run per safety rules). Full per-phase archive (what/why/tests/gates) in **[evolution/milestones/](evolution/milestones/)** (`checklist.md` + `arch-design.md` + `plans/`).

Forward work — deferred features + the M7+ roadmap — lives in **[evolution/roadmap.md](evolution/roadmap.md)**; per-phase tracking in **[evolution/checklist.md](evolution/checklist.md)**; new plans go in `evolution/plans/`.
