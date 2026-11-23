# Folio — Engineering Conventions

Folio is a self-hosted crypto portfolio tracker: on-chain wallets, Bitcoin, CEX, perp DEX and manual assets in one dashboard.
Read this file first every session. Forward scope: [docs/roadmap.md](docs/roadmap.md). Deploy: [apps/web/DEPLOY.md](apps/web/DEPLOY.md).

## 0. Language and comments (overrides everything below)

**Language.** Talk to the maintainer in Chinese — short, answer first, plain words, reasons only when asked; honest over brief. **Everything written into the repo is English**: code comments, docs, commit messages, issues, PR titles and bodies.

**Comments.** The code explains itself; a comment earns its place only by saying what the code cannot:
- Keep: the *why* behind a non-obvious choice — platform constraints, upstream API quirks, workarounds, invariants a reader would otherwise break. One or two lines.
- Drop: anything that restates the code, narrates history ("used to…", "changed from…"), or cites issues / PRs / ADRs / tickets. History lives in git.
- Prefer a better name or a smaller function over a comment.
- Tool directives (`biome-ignore`, `/// <reference>`, `@ts-expect-error`) are not comments — keep them.

## Tech stack
- TanStack Start (`@tanstack/react-start`, not the old `@tanstack/start`) + Vite: full-stack app with server functions.
- Cloudflare Workers (via `@cloudflare/vite-plugin`) + D1 (SQLite) + Drizzle ORM; better-auth (Drizzle adapter).
- pnpm workspace monorepo; TypeScript 7 strict; Vitest 4; Biome; knip; Wrangler 4 (`wrangler.jsonc`, not `.toml`).
- Effect 3.x for async orchestration; outbound HTTP through `@effect/platform`'s `HttpClient`.

## Core principles (non-negotiable)
1. **Contract-first** — types and the `BalanceProvider` interface before implementations; every provider implements the same interface.
2. **Test-first** — adapters get tests against recorded fixtures before the implementation; parsing logic gets golden tests.
3. **Split by "who we talk to / how we translate", not by provider.** Each upstream's request layer is its own package `packages/clients/<x>` (`@folio/<x>-client`, SDK-style `createXxxClient(config)`, transport kept internal). Adapters (`parse*`, `BalanceProvider` implementations, account creds) live in `@folio/connectors` under `src/connectors/<id>/`; a connector is a manifest (account creds spec + balance schema + providers). The contract base is `@folio/connectors-basic`. UI lives in `@folio/ui`. Never create per-provider packages.
4. **Tests beside src** — each package's tests in `tests/`, recorded API fixtures in `tests/fixtures/`.
5. **Secrets never leave, never echoed** — see Security model.
6. **`@folio/db` exports only wrapped, user-scoped ops** — no Drizzle instance or schema handle. Outside the package there is one entry point, the aggregate `Database` service whose fields are the domains (`(yield* Database).accounts.list()`); the reference layer likewise exposes one `Oracle` (`tokens` / `fx` / `platforms`). Methods take no user parameter: each op reads `CurrentUser` at the moment it runs, so an effect with no user doesn't compile. The `CurrentUser` Tag never leaves `@folio/db`; in the app only `apps/web/src/lib/server/runtime.ts` provides it. The test for scoping is "does this table have an owner?" — if yes it is user-scoped, no exceptions. The only unscoped tables are `global_token_ref_index` and `token_daily_prices`: public upstream knowledge, rebuildable, no user data.

## Domain rules
- Holdings merge only by `tokens.id` (per-user token identity), **never by symbol** — symbols collide (dozens of "USDC"); a fake token must never inflate a real total.
- A `tokenRef` (`<namer>/<localName>`, e.g. `evm:1/contract:0x…`, `coingecko/issued:usd-coin`) is the external naming of a token. Build and parse it only through `@folio/oracle-ref`; it appears only at the connector and oracle boundaries, never in `apps/web`. Unknown shapes parse as `unknown`.
- `platform` (chain or venue: `evm:<chainId>`, `binance`, `manual`…) is reported by the provider on each balance; never derive it from the tokenRef namer.
- `kind` (`spot` / `defi` / `perp_equity` / `perp_position`) exists only to drive shared logic (aggregation, net worth, routing). Typed `meta` per kind, exhaustive `switch (kind)`, no `as`. Display-only provider details go in a `Note` (account-level or balance-level), never a new kind.
- All storage and aggregation is in USD. Display currency is a presentation-only conversion: `display = value / usd_per_unit`.
- CoinGecko is known only to `@folio/oracle-upstream-coingecko`. The `@folio/oracle` service package may depend on no client or upstream package (only `@folio/oracle-ref`); the app wires the upstream in.
- Manual accounts write no snapshots; their value is computed from the activity ledger on read.
- CEX accounts with several wallets sync best-effort: a failing wallet doesn't fail the account, it becomes an account-level Note.
- Scoping happens on the server: account-domain reads take a `portfolioId` and return only that portfolio; never ship everything and filter on the client. `accountsInView` excludes archived accounts (totals); the membership set includes them (accounts page) — pick by "does this page show archived?".
- Requests carry no compute (free plan: 10 ms CPU per request). Authed pages are `ssr: false`. Small raw data → send it, compute in the browser; large input / small result → precompute at sync time into `user_cache`; recompute after a mutation in `waitUntil` with an optimistic UI update.
- Background jobs run in the `JobRunner` Durable Object, one job per alarm (50 subrequests per invocation); every job must be idempotent.

## Package conventions
- Create packages only when something needs them. Workspace globs already cover `packages/*`, `packages/clients/*`, `packages/connectors/*`, `packages/oracle/*`, `packages/oracle/upstreams/*`, `apps/*`.
- Internal packages: `"exports": { ".": "./src/index.ts" }`, no build step; consumers depend via `"@folio/<x>": "workspace:*"`.
- Shared dependency versions are written once in the `catalog:` of `pnpm-workspace.yaml` (`pnpm check:catalog` enforces it): any dependency used by ≥2 packages is `"catalog:"`; single-consumer deps keep a version; peerDependencies stay out (peer ranges are deliberately wider). Change the catalog, then `pnpm install`.
- No TS project references; each `tsconfig.json` extends `../../tsconfig.base.json`.
- Each package ships a minimal `vitest.config.ts` + `"test": "vitest run"`, so it doesn't inherit the root `projects` config and the root runner (`pnpm test:packages`) discovers it.

## Coding conventions

### General
- Imports never carry extensions. In `apps/web`, cross-directory imports use `@/` (→ `apps/web/src/*`), same-directory ones `./`; targets outside `src/` stay relative. `packages/*` have no alias. The alias must be enabled in every resolver (`vite.config.ts`, each project of `vitest.config.ts`, `vitest.workers.config.ts`: `resolve: { tsconfigPaths: true }`) — they don't inherit; a missing one shows as `Cannot find package '@/…'`.
- kebab-case filenames; components and types `PascalCase`, functions and variables `camelCase`, constants `UPPER_SNAKE`.
- No hardcoding: name every magic number; env-specific values → env, stable domain values → the package's `constants.ts`.
- Prefer mature libraries over hand-rolling (crypto, BIP32, dates, decimals). A new dependency must run on CF Workers, be maintained with no severe CVEs, be worth its complexity, and not conflict with existing deps; state the choice in the PR.
- One concept, one word (`token` everywhere, not `coin`). One situation, one way: follow how sibling implementations do it.
- Debug with structured logs (`getLogger(["folio", …])`) and a real request; read the actual error and `cause` before fixing.

### Implementation shape
- Functional factories, not classes: `createXxx(config): Interface` closures, no `this` (Effect `Service` / `Tag` declarations excepted). Stateless logic → top-level functions taking dependencies as parameters.
- Facades expose intent (`pricesOf`, `enrich`, `warm`), not collaborators (`.store`, `.provider`); cache→fetch→write, single-flight and TTL stay inside. Callers pass raw identity; the module builds its own refs.
- No logic-free forwarding wrappers (renames, reshaped arguments) — call the target. A wrapper stays only if it decides something (binds a constant, closes over state, adds a branch). Don't extract a helper just because two or three calls look alike.
- Guard clauses: early return / throw for preconditions; a dispatch function only picks a route and returns.
- Read the `cloudflare:workers` env at call time from one server-only binding site, never at module load.
- Outside Effect packages, call global `fetch(url, init)` directly; never stash it on an object and call it as a method (`deps.fetchImpl(url)`) — workerd throws `Illegal invocation`. Mock with `vi.spyOn(globalThis, "fetch")`. Runtime globals (fetch / crypto / clock) never get a test-only injection parameter on a production signature.

### Client / server boundaries (`apps/web`)
- Client code value-imports only contract packages (`@folio/connectors-basic`, `@folio/oracle-basic`), never entry packages (`@folio/connectors`, `@folio/oracle`) — that drags every provider and server-only deps into the client bundle.
- A package exporting a `Context.GenericTag` makes its main entry server-only (`effect` adds ~75 KB gzip to the client); put Tags in a subpath (`@folio/oracle-basic/ports`).
- In a client-imported module, `cloudflare:workers` / node built-ins may be referenced only inside a `createServerFn` handler (the compiler strips it); a plain exported function using them breaks the client build — move it to a server-only module.
- `apps/web/src/lib` is layered by "can the client use it?":
  - `lib/core/` — pure modules the client actually *calls* (`import type` doesn't count; server-only logic with a client-visible type lives in `lib/server`).
  - `lib/hooks/`, `lib/i18n/`, `lib/queries/` — client-only.
  - `lib/server/<resource>/index.ts` — the `createServerFn` surface, assembly only: `createServerFn({ method }).middleware([requireAuth]).validator(Input).handler(runEffect(handleX))`. The client imports only this layer (plus `import type` anywhere). The zod input schema lives with its handler in the action file.
  - Everything else under `lib/server/` is server-only, including anything importing `Effect`.
  - No files at the top level of `lib/`; a module with a single user lives next to that user.
- Handlers describe business and return an Effect; `runtime.ts` runs them (`runEffect` / `runForUser` / `forUser`) and supplies the user — handlers take no `context`.
- Pure logic with node-env unit tests never shares a file with a handler or anything pulling `cloudflare:workers` (it drags the test into the workers chain); give it its own `.ts` next to its user. On a name clash the handler file is verb-noun (`sync/get-status.ts`).
- Split a mixed module along responsibility, not along client/server. Count a symbol's users before moving it.

### File placement
- Keep a page's pieces together; only genuinely generic building blocks go to shared directories. Sharing is not a reason for a new file: put shared logic in the file of the concept it belongs to. A standalone file needs its own logic and more than one user.
- Folders export one entry, not a re-export hub. Skeleton / empty / error states live in the file that uses them. Delete files that only wrap one call.
- Separate animation from business logic; small same-file subcomponents are fine. Don't merge unrelated concerns into one hook.

### UI
- `@folio/ui` = beUI (Framer Motion) components + a few hand-rolled primitives. **Never Radix or Base UI** (`radix-ui`, `@base-ui/react`, and anything depending on them, e.g. `vaul`).
- Add beUI components only via `pnpm dlx shadcn@latest add @beui/<name>` (lands in `packages/ui/src/components/motion/`, export from `src/index.ts`); never edit their internals. Basics beUI lacks (Card / Avatar / Separator / Skeleton) are hand-rolled token-only primitives.
- Component sourcing: ① a beUI component, or a composition of beUI / existing primitives; ② otherwise a non-Radix shadcn component — tell the maintainer first; ③ otherwise tell the maintainer and propose a hand-rolled token-only primitive, and wait for approval. Add dependencies when first used, not ahead.
- Design tokens only — no custom colors, no arbitrary values (`bg-[#…]`, `p-[13px]`); motion via `lib/ease.ts` spring/easing tokens. Data-viz SVG is the only exception, and still uses `--chart-*` / semantic tokens.
- Every money amount and asset quantity renders through `<Sensitive>` (balance privacy blur, fail-closed); percentages and charts don't.
- Page entrance animations move only `opacity` and `y` (rest at exactly 0), never `scale` / `filter` — a transformed ancestor becomes the containing block for absolutely positioned children.
- Use a component's native API (controlled props, built-in behaviour) over overlays and focus hacks; when unsure what it supports, read its types.

### React
- Server data goes through react-query: `queryOptions` in `lib/queries/<domain>.ts`, route loaders only prefetch (`ensureQueryData`), components use `useSuspenseQuery`. Refresh with `invalidateQueries` on hierarchical keys (`["portfolio", "overview", portfolioId, pin]`); never `router.invalidate()` (it can't refresh `ensureQueryData` caches). Every mutation must invalidate what it changed — a missed key is a silent stale screen.
- The four pages are one route kept alive with `<Activity>`; in-page state (tabs, dimensions, open account) lives in component state. The URL carries only `?portfolio` (default omitted) and the one-shot `?focus`.
- No `useEffect` for fetching or derived state: debounce with `useDeferredValue`, derive with `useMemo` / inline; `useEffect` only for genuine one-off side effects.
- Lift conditional JSX into named variables and keep the returned tree flat; extract stateful sub-views (loading / error / empty) into named same-file components.

### Effect
- Anything swappable (outbound HTTP, cache backend, signer, rate-limit tier) is a service read with `Effect.serviceOption`, not a config field. If only tests would pass a field, it isn't a field. No callbacks on config objects — make the step a visible `pipe` at the call site (true effectful dependencies, like computing a signature header, are services).
- No `Scope` without a resource; a pure `make` returns a value. `Layer.succeed(tag, make(config))` evaluates eagerly — use `Layer.sync`.
- A service's method signatures never expose its own dependencies: capture context when the service is built (`Effect.context` + `Effect.provide`). The one exception is `DbRequest` (`CurrentUser | DbClient`), which every db-touching method carries and `runtime.ts` provides per request; when handing work to an `R = never` port inside a request, capture it with `Effect.context<DbRequest>()`.
- Derive service types from the implementation; don't hand-write a parallel `interface`. Parameterless services: `class X extends Effect.Service<X>()("pkg/X", { effect: make }) {}`; test fakes use `new X({ … })`. Annotate each method's return type. Ports with several implementations keep a standalone interface whose `Context.GenericTag` shares its name.
- Service names: singular + role suffix — `Store` / `Upstream` / `Source` / `Client` > a bare capability (`Clock`) > `Service`. Never `Resolver` (clashes with Effect's `RequestResolver`).
- One `Effect.promise` bridge per wrapped promise library (`DbClient.query(build)` / `batch(build)` in `@folio/db`); it takes builders, never prebuilt statements, and never leaves the package.
- In Effect packages, never call global `fetch` directly — it loses the `AbortSignal`, so requests outlive timeouts. Plain `const f = globalThis.fetch; f(url)` is fine on workerd (that's how `FetchHttpClient` calls it).
- Migrate a package only if it has Effect consumers; a low-value package may never migrate.
- **Errors:** split error types by what the consumer must distinguish, not by upstream (all upstreams share four: credentials / rate-limited / unreachable / unreadable). Match on `_tag`, never `instanceof`. `E` holds only what someone handles; everything else is a defect. `NotFound` covers both "doesn't exist" and "not yours" (separate errors would let users probe others' ids); an id the code just created → `Effect.orDie`.
- **Degrade by type and leave a trace:** `catchAll` on the typed upstream errors + `logWarning`, never a blanket `try/catch`. Degrade to `Option.none()` when "upstream says none" and "upstream is down" need different follow-ups.
- **Retry** at the level of one full business operation (`@folio/sync`), not per HTTP request; the rate-limit gate sits inside the retry.
- **State on Workers:** the isolate-level runtime in `runtime.ts` lives across requests; layers provided per request are rebuilt each request. Isolate-level layers may build only closures — anything holding a fiber, timer or I/O handle at build time (connections, `RateLimiter`, `Cache`) stays per-request, because Workers forbid using one request's I/O objects in another. On hot paths, build a `Context` directly instead of composing Layers.
- **Adopted defaults are adopted risks:** `HttpClient` spans record full URLs, query strings and headers and inject `traceparent` by default. Harden at the point of use, not in a production-only layer; record by allowlist; pin it with tests asserting what is *absent*.

### Tests
- Vendored beUI primitives aren't unit-tested; test our compositions, hooks and pure functions.
- Scenario tests walk a user path end to end (real D1, real orchestrator, real view assembly; stub only fetching / outbound) and check three things: what was stored, its values, what the screen row shows (`apps/web/tests/server/scenarios.test.ts`). A fixture that bypasses the code under test makes the assertion empty — after writing a test, break the line it covers and confirm it goes red.
- In `apps/web`, the file suffix picks the environment: `*.test.ts` → node, `*.test.tsx` → jsdom. Don't collapse it into one `environment` setting. When tests are slow, read the breakdown in vitest's `Duration` line before cutting tests.
- Never assert on wall-clock time. With a gate: fake timers + count requests (`advanceTimersByTimeAsync(0)` for the burst, `runAllTimersAsync()` for the total). Without a gate: fake timers and `await Promise.all(...)` without advancing. Real-timer workerd tests assert only lower bounds.
- Effect timing tests use `TestClock` and exact values. `TestClock` can't see microtasks from fake fetches (flush with `Effect.repeatN(Effect.yieldNow(), n)`) or Node's `crypto.subtle` (macrotasks) — run to completion and check how far virtual time moved. `TestContext`'s `Random` is not deterministic.
- Share one test harness per layer of the stack instead of copying setup into each package, and exercise the production Tag → Layer path (don't export `make*` just for tests).
- `@effect/vitest` can't be installed (no release supports both vitest 4 and Effect 3); don't re-evaluate until Effect 4 is stable.

## Toolchain and platform gotchas
- **Vitest projects:** root `test.projects` globs each package's config file (`packages/**/vitest.config.ts`), not directories — a directory glob also matches container folders and the run fails on colliding unnamed projects.
- **TypeScript 7** has no programmatic API until 7.1, so nothing may `import typescript` (no `typescript-eslint`; `tsc --strict` is the only type check). Never use options TS7 dropped: `baseUrl`, `downlevelIteration`, ES5 target, AMD/UMD/SystemJS, `moduleResolution: node/node10/classic`, `esModuleInterop: false`. `paths` still works without `baseUrl`.
- Annotate byte arrays passed to Web Crypto / D1 as `Uint8Array<ArrayBuffer>` (`Uint8Array<ArrayBufferLike>` isn't assignable to `BufferSource`).
- **D1 tests:** `@cloudflare/vitest-pool-workers` 0.16 with the root `cloudflareTest` plugin + `readD1Migrations`; `env` / `applyD1Migrations` from `cloudflare:test`; `Cloudflare.Env` augmentation in a test `env.d.ts`. Storage isn't isolated per test — reset state in `beforeEach`.
- **D1 batches:** there is no interactive `db.transaction()`; use `db.batch([...])`. A batch is one implicit transaction run in order — later statements see earlier writes, one failure rolls back all. So resolve dependent values with a subquery inside the later statement (`… VALUES (…, (SELECT id FROM t WHERE <dedup key> = ?))`) instead of read-then-write in JS. Probe a supposed D1 limit with a throwaway test before designing around it. FKs are enforced (`ON DELETE CASCADE` works).
- **Migrations:** `drizzle-kit generate` in `packages/db` (out = `drizzle/` = wrangler `migrations_dir` = test `readD1Migrations` path); never `drizzle-kit migrate`. Apply from `apps/web` only: `pnpm --filter @folio/web db:migrate:local` after a schema change (dev-server auto-apply is unreliable), `db:migrate:remote` before deploy. `packages/db/wrangler.jsonc` has a placeholder `database_id` for tests — applying there hits the wrong database.
- **Miniflare keys the local D1 file off `database_id`**, not the name: change the id and the dev server silently gets an empty database (`Failed to get session`). Then run `db:migrate:local` and re-register.
- **Column renames** make `drizzle-kit generate` prompt and fail without a TTY — drive it with `expect` (down-arrow + enter for "rename column"). Renaming a PK column rebuilds the table.
- **Data-version triggers:** user-visible tables carry SQLite triggers that bump `user_data_version`. A migration that rebuilds a table they reference (`accounts`, `portfolios`, `user`, any triggered table) fails at the RENAME and silently drops that table's triggers — paste the drop block from `pnpm --filter @folio/db db:triggers` at the top of the migration and the create block at the end. A new table with an owner column must be decided in or out of the triggers (`data-version.test.ts` enforces).
- **better-auth on CF Workers** (separate causes, don't conflate):
  - One module-level auth instance, lazily built from `cloudflare:workers` `env` — a per-request instance causes D1 write-lock contention (local hangs, prod 503s).
  - No auth calls at module load (Worker startup CPU limit).
  - Post-response work (token cleanup, session writes) goes in `ctx.waitUntil`, or the Worker exits first (`Network connection lost`).
  - Native `node:crypto` scrypt is picked up via `nodejs_compat`; no hash override.
  - secondaryStorage TTL must be ≥ 60 s (KV minimum; `Math.max(ttl, 60)`).
  - `cookieCache` stays on (5 min): without it every server fn pays a D1 session read (~2–3 ms of the 10 ms budget). A revoked session can live up to 5 min on another device; use `disableCookieCache: true` where revocation must be immediate.
  - `@better-auth/cli` doesn't work here; the Drizzle auth schema is hand-written per the official spec. Test with curl using `Origin: http://localhost:3000` (CSRF guard).
- **Server routes:** `createFileRoute("/path/$").server.handlers` (GET/POST → `Response`); `src/env.d.ts` keeps `/// <reference types="@tanstack/react-start" />` so `tsc` sees the `server` option. Run `wrangler types` after editing bindings in `wrangler.jsonc`.
- **Tailwind v4** doesn't scan `node_modules`, so workspace packages need `@source` on real source paths (`@folio/ui` `globals.css`: `@source "../**/*.{ts,tsx}"`; `apps/web` `styles.css`: `@source "./**/*.{ts,tsx}"`); missing it = compiles but unstyled. `@folio/ui` owns the Tailwind entry and theme tokens.
- **Biome 2:** `pnpm lint` / `pnpm lint:fix`; CI runs `biome ci`; both with `--error-on-warnings`. `linter.domains` enables `react` / `test` explicitly because auto-detection can't read `"catalog:"` versions and would silently disable those rule groups. A `biome-ignore` must be a single-line comment directly above the code line; put explanations in a separate comment above it. 2-space indent, double quotes, line width 100. `noNonNullAssertion` is off only in tests.
- **Coverage:** istanbul, one repo-wide number (`pnpm coverage`); CI fails under 80% lines (`pnpm coverage --min 80`). Not v8: workerd has no `node:inspector`, and v8 skips never-loaded files. Ask "should this really be untested?" before adding an exclusion. `@vitest/coverage-istanbul` is pinned to the vitest version — bump both together.
- **knip** runs in CI (biome → typecheck → knip → check:catalog → build → coverage); unused files / exports / deps fail the PR. Delete unused exports, or drop `export` if used only locally. `knip.json` ignores only structural false positives — never add real dead code to its ignore lists.

## Security model
- Global provider keys (e.g. `ZERION_API_KEY`) are CF secrets / env.
- Per-account credentials are one `creds` map in D1 (column `enc_credentials`), encrypted per field by type: `secret` fields AES-GCM with `SECRETS_KEY` (Web Crypto), `public` / `semi` stored plaintext. APIs return only the safe projection (`safeView`: public whole, semi masked, secret dropped) + `needsCredentials`.
- Credential shaping (seal / open / safeView / isComplete) lives in `apps/web/src/lib/server/creds.ts`, driven by the field types from `credentialSpecs()`; `@folio/connectors` does only provider work and never sees `SECRETS_KEY`.
- Read-only tracking, no signing: no private-key field in any connector; on-chain accounts store only addresses / xpubs (`public`).
- Decrypt only inside server functions / sync at fetch time, discard immediately, never log. Logs carry only accountId / type / code / counts.
- Logos are served through `/api/logo/:kind/:id` by internal id; the client never loads third-party image CDNs (that would leak holdings).

## Git and PR workflow
- Issues and PRs live on GitHub.
- `main` only takes PRs: branch from `main` (`feat/*` etc.) before touching code; never push to `main`.
- Squash-merge only (keeps GitHub's Verified signature; rebase-merge makes commits Unverified). Commits are GPG-signed — don't break that.
- Small commits, one reviewable slice each, each passing typecheck / test / biome / build. Conventional-commit English messages (`type(scope): summary`).
- **Never `git commit` without explicit approval** — "提交" / "commit" authorizes it; "执行" / "go" does not.
- Planning drafts go in `.scratch/plans/` (gitignored), never in the repo.
