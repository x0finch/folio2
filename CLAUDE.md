# Folio

Self-hosted crypto portfolio tracker: on-chain wallets, Bitcoin, CEX, perp DEX and manual assets in one dashboard. Roadmap: [docs/roadmap.md](docs/roadmap.md). Deploy: [apps/web/DEPLOY.md](apps/web/DEPLOY.md).

## Language and comments (overrides everything)
- Talk to the maintainer in Chinese: short, answer first, plain words, honest over brief.
- Everything in the repo is English: comments, docs, test names, commits, issues, PRs.
- Comments only say what the code can't: the *why* behind a non-obvious choice (platform limits, upstream quirks, workarounds, invariants). One or two lines. No restating code, no history, no issue/PR refs. Prefer a better name over a comment. Tool directives (`biome-ignore`, `/// <reference>`, `@ts-expect-error`) stay.

## Stack
TanStack Start + Vite on Cloudflare Workers; D1 + Drizzle; better-auth; Effect 4, pinned `~4.1` (`effect/http` `HttpClient` for outbound); pnpm monorepo; TypeScript 7 strict; Vitest 4; Biome; knip; Wrangler 4 (`wrangler.jsonc`).

## Architecture rules
- Contract-first: every upstream implements a port from `@folio/upstream-basic` (`BalanceUpstream`, `PriceUpstream`, …) and fails only with its six `UpstreamError` tiers.
- Test-first: adapters get tests against recorded fixtures (`tests/fixtures/`); parsers get golden tests. Tests live in each package's `tests/`.
- Every upstream lives in `@folio/upstreams`, one folder each (`src/balance/<id>/`, `src/market/<id>/`: `constants.ts`, `api.ts`, `parse.ts`, `upstream.ts`), declared with `defineUpstream` (keys, base override, limits) and run by `src/runtime/`. Never per-upstream packages; `@folio/connectors` holds account kinds only (creds + which upstreams serve them).
- Upstreams read deployment keys only through `defineUpstream` `keys`: a missing key is `auth` before any request. Retries stay in `@folio/sync`.
- `@folio/db` exports only user-scoped ops via one `Database` service (`(yield* Database).accounts.list()`); reference data via one `Oracle`. Methods take no user param — ops read `CurrentUser` when they run; only `apps/web/src/lib/server/runtime.ts` provides it. Any table with an owner is user-scoped; only `global_token_ref_index` and `token_daily_prices` aren't.
- Merge holdings only by `tokens.id`, never by symbol.
- `tokenRef` (`<namer>/<localName>`) only at connector/oracle boundaries, built and parsed via `@folio/oracle-ref`. `platform` comes from the provider, never from the ref.
- `kind` (`spot` / `defi` / `perp_equity` / `perp_position`) only drives shared logic; display-only details go in a `Note`.
- Store and aggregate in USD; display currency is presentation only.
- CoinGecko is known only to `@folio/upstreams` (`src/market/coingecko/`); `@folio/oracle` depends on no upstream implementation, only on the ports in `@folio/upstream-basic`.
- Manual accounts write no snapshots (computed from the ledger). Multi-wallet CEX sync is best-effort (failed wallet → account Note).
- Scope on the server (`portfolioId`), never filter on the client.
- Requests carry no compute (10 ms CPU): authed pages `ssr: false`; precompute at sync into `user_cache`; recompute after mutations in `waitUntil`.
- Background jobs: `JobRunner` Durable Object, one job per alarm, idempotent.

## Packages
- Create a package only when needed. Internal packages export `./src/index.ts`, no build; depend via `workspace:*`.
- Deps used by ≥2 packages use `catalog:` (`pnpm check:catalog`); peerDependencies stay out.
- No TS project references; tsconfigs extend `../../tsconfig.base.json`. Each package has its own `vitest.config.ts` + `"test": "vitest run"`.

## Code
- No import extensions. `apps/web`: `@/` across dirs, `./` within; packages use relative paths. Every resolver config needs `resolve: { tsconfigPaths: true }`.
- kebab-case files; `PascalCase` components/types, `camelCase` functions, `UPPER_SNAKE` constants. Name magic numbers; env-specific → env, stable → `constants.ts`.
- Prefer mature libraries (must run on Workers, maintained, worth it, no conflicts).
- Factories and closures, not classes (Effect services excepted). No logic-free wrappers. Guard clauses.
- Read `cloudflare:workers` env at call time, never at module load.
- Outside Effect, call global `fetch` directly (method-call fetch throws `Illegal invocation` on workerd); mock with `vi.spyOn(globalThis, "fetch")`. Inside Effect, use `HttpClient` (keeps the abort signal); `FolioHttpClient` reads the global `fetch` per call, so the same spy works.

### apps/web boundaries
- Client code value-imports only contract packages (`@folio/connectors-basic`, `@folio/oracle-basic`). Effect Tags go in subpaths (`/ports`) so `effect` stays out of the client bundle.
- `cloudflare:workers` / node built-ins in client-imported modules only inside `createServerFn` handlers.
- `lib/core` pure client-callable; `lib/hooks`, `lib/i18n`, `lib/queries` client-only; `lib/server/<resource>/index.ts` is the server-fn surface (`createServerFn().middleware([requireAuth]).validator(Input).handler(runEffect(handleX))`, `handleX = serverFn("handleX")(…)` so the timing log has its name); the rest of `lib/server` is server-only. No files at the top of `lib/`.
- Handlers return Effects; `runtime.ts` runs them and supplies the user.
- Node-tested pure logic never shares a file with a handler.
- Keep a page's pieces together; shared dirs only for genuinely generic parts.

### UI
- `@folio/ui` = beUI (Framer Motion) + few hand-rolled primitives. Never Radix / Base UI / their dependents (e.g. `vaul`).
- beUI via `pnpm dlx shadcn@latest add @beui/<name>`; never edit its internals. Sourcing: beUI → non-Radix shadcn (tell the maintainer) → propose a hand-rolled token-only primitive and wait for approval.
- Design tokens only, no arbitrary values; motion via `lib/ease.ts`. Data-viz SVG uses `--chart-*` tokens.
- Money and quantities render through `<Sensitive>`.
- Page entrance animations move only `opacity` and `y`.

### React
- Server data via react-query: `queryOptions` in `lib/queries/<domain>.ts`, loaders only prefetch, components `useSuspenseQuery`. Invalidate hierarchical keys after every mutation; never `router.invalidate()`.
- The four pages are one route kept alive with `<Activity>`; URL carries only `?portfolio` and `?focus`.
- No `useEffect` for fetching or derived state.

### Effect
- Swappable things (HTTP, cache, signer) are services, not config fields; no callbacks in config.
- Use `Layer.sync`, not `Layer.succeed(tag, make())`. No `Scope` without a resource.
- Service signatures never expose their dependencies (capture context at build), except `DbRequest`.
- Derive service types from the implementation: `class X extends Context.Service<X>()("pkg/X", { make })` with `static readonly layer = Layer.effect(this, this.make)`; the shape type is `X["Service"]`; annotate method return types. Name with role suffix (`Store`, `Upstream`, `Source`, `Client`); never `Resolver`.
- Errors split by what the consumer must distinguish; match `_tag`; unhandled → defect. `NotFound` covers "not yours".
- Degrade with typed `catch` / `catchTag` + `logWarning`, never blanket try/catch. Retry whole business operations in `@folio/sync`.
- Isolate-level layers build only closures; anything holding I/O (connections, `RateLimiter`, `Cache`) is per-request.
- `HttpClient` spans record full URLs/headers by default — record by allowlist and test what's absent.

### Tests
- Don't unit-test vendored beUI. Scenario tests (`apps/web/tests/server/scenarios.test.ts`) assert what was stored, its values, and what the screen shows; break the covered line to confirm the test goes red.
- `apps/web`: `*.test.ts` → node, `*.test.tsx` → jsdom.
- Never assert wall-clock time; use fake timers / `TestClock`.
- No `@effect/vitest`: 4.x needs vitest 5, and `@cloudflare/vitest-pool-workers` still needs vitest 4. Use `TestClock` from `effect/testing`.

## Platform gotchas
- Root vitest `test.projects` globs config files (`packages/**/vitest.config.ts`), not dirs.
- TS7: nothing may `import typescript`; never use `baseUrl`, `downlevelIteration`, ES5, AMD/UMD/SystemJS, `moduleResolution: node*/classic`, `esModuleInterop: false`. `paths` is fine.
- Byte arrays for Web Crypto / D1: `Uint8Array<ArrayBuffer>`.
- D1 tests: `@cloudflare/vitest-pool-workers` 0.16 + `readD1Migrations`; storage isn't isolated — reset in `beforeEach`.
- D1 has no `transaction()`; `db.batch()` is one ordered transaction — resolve dependent values with subqueries, not read-then-write.
- Migrations: `drizzle-kit generate` in `packages/db`; apply only from `apps/web` (`db:migrate:local` / `db:migrate:remote`). Never `drizzle-kit migrate`.
- Miniflare keys local D1 off `database_id`; changing it gives an empty DB → `db:migrate:local` and re-register.
- Column renames need a TTY (drive `drizzle-kit generate` with `expect`).
- Rebuilding a table referenced by data-version triggers drops them: wrap the migration with the drop/create blocks from `pnpm --filter @folio/db db:triggers`. New owner tables must be decided in/out of the triggers.
- better-auth: one lazy module-level instance; no auth calls at module load; post-response work in `ctx.waitUntil`; secondaryStorage TTL ≥ 60 s; `cookieCache` on (5 min); auth schema is hand-written (CLI doesn't work).
- Server routes: `createFileRoute(...).server.handlers`; keep `/// <reference types="@tanstack/react-start" />` in `src/env.d.ts`; run `wrangler types` after binding changes.
- Tailwind v4 needs `@source` on real workspace source paths.
- Biome runs with `--error-on-warnings`; `linter.domains` sets `react`/`test` explicitly. `biome-ignore` must be a single line directly above the code.
- Coverage: istanbul, CI fails under 80% (`pnpm coverage --min 80`). Don't add exclusions to inflate it.
- knip in CI: delete unused exports/files/deps; never silence real dead code.

## Security
- Provider keys are CF secrets. Per-account `creds`: `secret` fields AES-GCM with `SECRETS_KEY`, `public`/`semi` plaintext. APIs return only `safeView` + `needsCredentials`. Shaping lives in `apps/web/src/lib/server/creds.ts`.
- Read-only: no private keys anywhere; on-chain accounts store addresses / xpubs.
- Decrypt only at fetch time, never log secrets (log accountId / type / code / counts).
- Logos go through `/api/logo/:kind/:id`; the client never hits third-party image CDNs.

## Git
- Issues and PRs on GitHub. Branch from `main`; never push to `main`. Squash-merge only. Commits are signed.
- Small commits, each passing typecheck / test / biome / build. Conventional-commit messages.
- Never `git commit` without explicit approval ("提交"/"commit" yes; "执行"/"go" no).
- Planning drafts go in `.scratch/plans/` (gitignored).
