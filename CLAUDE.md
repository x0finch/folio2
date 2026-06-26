# Folio — Engineering Conventions & Progress

> **Folio** is a self-hosted crypto portfolio tracker (on-chain wallets + CEX + perp DEX + manual assets → one dashboard). Full blueprint: [evolution/arch-design.md](evolution/arch-design.md). Read this file first every session, do only the current phase, then update the Progress block and stop.

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
5. **Secrets never leave / never echoed** — APIs return only `has*` booleans, never credential values. All credentials encrypted at rest (AES-GCM via Web Crypto, `SECRETS_KEY` from env).
6. **`@folio/db` exposes only wrapped ops** — no Drizzle instance / schema handle exported; only userId-scoped domain functions. All data access funnels through here.
7. **Relative imports without extensions** — `moduleResolution: bundler` workspace-wide; write `import './foo'`, never `./foo.js` or `./foo.ts`.
8. **No hardcoding** — chain IDs, RPCs, API bases, gap limits, derivation paths, timeouts, concurrency, TTLs → config/constants/env. Magic numbers must be named. Volatile env-specific values → env; stable domain constants → each package's `constants.ts`.
9. **Prefer mature, vetted libraries** — before each phase ask if a widely-adopted lib/standard exists (signing, BIP32, crypto, dates, decimals — don't hand-roll). A library must pass 4 gates or be rejected: ① runs on CF Workers (no Node-native deps, reasonable size); ② actively maintained, no known severe CVEs; ③ complexity matches payoff; ④ no conflicting transitive deps. Record the choice (what/why/rejected) in the commit or here.
10. **kebab-case filenames; exports keep their own convention** — files/dirs lowercase-hyphenated (`balance-table.tsx`, `create-account.ts`), decoupled from export names. Exports: React components PascalCase, functions/vars camelCase, types/interfaces PascalCase, constants UPPER_SNAKE.
11. **UI = shadcn design system only** — colors/spacing/radius/fonts via shadcn design tokens (CSS vars: `bg-background`, `text-foreground`, `border-border`, …). No hardcoded color values, no arbitrary-value classes (`bg-[#...]`, `p-[13px]`), no editing component internals. New visuals = compose existing shadcn components or adjust theme tokens.
12. **Small commits** — commit each acceptance-worthy unit; message ties contract/test/impl together.

## Package conventions (monorepo)
- **Packages are created on-demand by the phase that needs them** — not pre-stubbed. P1.2 creates `packages/core`, P1.4 `packages/db`, P1.5 `packages/ui`, each provider when built. The workspace globs in `pnpm-workspace.yaml` already cover `packages/*`, `packages/providers/*`, `apps/*`, so new packages need no config change.
- **Internal-packages pattern**: each `@folio/*` package.json sets `"exports": { ".": "./src/index.ts" }` pointing at source — **no build step** for internal libs (Vite/Vitest transpile TS directly). Consumers depend via `"@folio/<x>": "workspace:*"`.
- **No TS project references** (overkill here); each package `tsconfig.json` just extends `../../tsconfig.base.json`.
- Package prefix `@folio/*`. Providers published as `@folio/provider-<name>`.

## Toolchain notes (current best practices — supersede older wording in arch-design.md)
- **`wrangler.jsonc`** (not `wrangler.toml`) — Cloudflare's recommended format; some features JSON-only. Wrangler v4.
- **Vitest 4** with root `test.projects` in `vitest.config.ts` (`vitest.workspace.ts` is removed in v4).
- **Cloudflare targeting via `@cloudflare/vite-plugin`** (not the legacy Nitro `cloudflare-module` preset).
- Package name is **`@tanstack/react-start`** (the old `@tanstack/start` is gone).
- TypeScript: `module: preserve` + `moduleResolution: bundler` (now the modern defaults) enable extension-less relative imports.

## Security model (see arch-design.md §3, §7.1)
- Global provider keys (`ZERION_API_KEY`, etc.) → CF Secret/env. Per-account credentials → D1, AES-GCM encrypted with `SECRETS_KEY`.
- Read-only tracking, **no signing** → `ProviderCredentials` has no private-key field; on-chain accounts store address/xpub only.
- Decrypt only inside server functions at fetch time, discard immediately, never log.
- better-auth CF gotchas (apply in P2.1): native `node:crypto` scrypt hash override; single module-level auth instance; `ctx.waitUntil` for background tasks; secondaryStorage TTL ≥ 60s; disable cookieCache; no auth calls at module load.

---

## Progress

- [x] **P1.1 — monorepo skeleton** (workspace shell + `apps/web` + base configs + this file). Packages created on-demand thereafter.
- [ ] **P1.2 — core contracts** (creates `packages/core`: types, `BalanceProvider`, registry, errors) ← **next**
- [ ] P1.3 — credential crypto (`@folio/core/crypto.ts`)
- [ ] P1.4 — Drizzle schema + `@folio/db` wrappers
- [ ] P1.5 — `@folio/ui` shadcn init
- [ ] P1.6 — CI
- [ ] M2+ — auth, manual provider, sync, UI loop, on-chain, CEX, perp, polish (see arch-design.md §9)
