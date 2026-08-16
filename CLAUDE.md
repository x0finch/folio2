# Folio — Engineering Conventions

> **Folio** is a self-hosted crypto portfolio tracker (on-chain wallets + Bitcoin + CEX + perp DEX + manual assets → one dashboard). M1–M6 (foundation → on-chain → CEX → perp → polish) are complete and shipped — architecture overview in [docs/architecture/](docs/architecture/00-overview.md); decision history in git log + [docs/adr/](docs/adr/). Forward work: [docs/roadmap.md](docs/roadmap.md) (narrative + scope; links the epic board). Read this file first every session. Coding conventions (imports, naming, UI, React, tests, commits): see [CODING.md](CODING.md).

## 0. 说人话(高于本文件其余一切)

**全程中文。默认短。结论先行。**

- **先给答案,再给理由。** 一两句话说完的事就一两句话说完;背景、权衡、边界情况等被问了再给。
- **别倒术语。** 内部黑话("mint 决策树"、"锚"、"SWR 编排")在自己脑子里用,对外换成日常说法("怎么认出这是哪个币")。首次不得不用某个词时,顺手一句解释。
- **别一次铺一堆表格。** 表格是被要求"逐个列出"时才用的形状,不是默认形状。
- **诚实优先于简短。** 说人话不等于打包票:没验过的就说没验过,做砸了就直说,坏消息别裹在长段落里。
- 用户明确要"详细/逐条/全部列出"时照做 —— 那时长是对的。

**为什么写在这:** 这条被反复纠正过多次("说人话"、"太长了")。它不是风格偏好,是返工成本 —— 一段读不进去的回复等于没回复。

## Tech stack
- TanStack Start (`@tanstack/react-start`) + Vite — full-stack, server functions
- Cloudflare Workers runtime; Cloudflare D1 (SQLite) + Drizzle ORM
- better-auth (Drizzle adapter) for auth
- pnpm workspace monorepo; TypeScript strict
- Vitest (test-first); Wrangler for deploy
- **Effect**(3.x)作异步编排层,逐包迁移中(ADR 0035);出网走 `@effect/platform` 的 `HttpClient`。Effect 相关的约定 —— 服务 vs config 字段、错误面怎么划、CF Workers 上状态活在哪、TestClock 的边界 —— 见 **[CODING.md 的 Effect 一节](CODING.md#effect)**,**写 Effect 代码前先读它**

## Core principles (non-negotiable)
Architecture & security principles (1–6) live here; coding-style principles (7–12) are kept as numbered anchors — full text in **[CODING.md](CODING.md)**.

1. **Contract-first** — define types & the `BalanceProvider` interface before implementations. Every provider implements the same interface.
2. **Test-first** — each provider adapter gets tests against recorded fixtures before its implementation. Parsing logic must have golden tests.
3. **Modular** — 按「跟谁说话 / 怎么翻译」切包,不按 provider 切(**ADR 0036 改**,迁移进行中):**请求层**各上游一个独立 client 包(`packages/clients/<x>`,如 `@folio/blockbook-client` —— SDK 式出口 `createXxxClient(config)`,传输层内部化);**适配层**(`parse*` 纯函数 / `BalanceProvider` 实现 / `accountCreds`)全部落 `@folio/connectors-entry`,provider **不再是包边界**。契约基座 `@folio/connectors-basic` 独立不动,所有 provider 仍实现同一接口。UI lives in `@folio/ui`。
   - `packages/connectors/providers/*` 那一层**已整层删除**(#376 B 批做完):九个上游的请求层都在 `packages/clients/*`,适配层都在 `@folio/connectors-entry` 的 `src/connectors/<id>/`。新上游照这个形状建。
4. **Tests beside src** — each package's tests go in `tests/` (sibling of `src/`); provider API fixtures in `tests/fixtures/`.
5. **Secrets never leave / never echoed** — APIs never return credential values; only a safe projection (`safeView`: public whole, semi masked, secret dropped) + `needsCredentials`. Per-account creds are one `creds` map, encrypted **per field by `type`** — only `secret` fields AES-GCM-encrypted (Web Crypto, `SECRETS_KEY` from env); `public`/`semi` plaintext (P6.6.1). **creds shaping lives in the app** (`apps/web/src/lib/core/creds.ts`: seal/open/safeView/isComplete/categorize), driven by `@folio/balances`'s `credentialSpecs()` field `type`s + Web Crypto — `@folio/balances` only does provider-facing work (`validateCredentials`/`fetchBalances`) and never sees `SECRETS_KEY`.
6. **`@folio/db` exposes only wrapped ops** — no Drizzle instance / schema handle exported; only userId-scoped domain ops. All data access funnels through here. **「userId-scoped」现在的形状是 per-user 的 Effect 服务,不是签名里的参数**(ADR 0037,迁移中):`accountStoreLayer(userId)` 在装配那一刻把 userId 吃掉,`AccountStore` 的方法签名里一个 user 参数都没有 —— 拿错用户在编译期就发生不了。换掉的是签名级的审计可见性(以前 review 时 userId 就在眼前,现在要往上找装配点),换来的是类型级的保证。过渡期那层 `createDb(env)` 门面**已经删掉**(#394 T8):它存在过,是为了让 app 那九十多处调用点一片一片搬而不是一个几千行的单体 PR;搬完最后一处它就该消失 —— 留着的话「一次请求一次装配」旁边永远并排站着一条「每次调用各装一次」的路。**两张表是受控例外**(#199,ADR 0022):`global_token_ref_index`(链上地址 → 上游的叫法)与 `token_daily_prices`(历史日价)不带 `user_id` —— 它们装的**一条用户数据都没有**,是上游的公开知识、可整表重建、删空只是下一轮慢一点,与搜索结果跨用户共用同理。判据就是这个:**表里有没有「谁的」这回事**。有 → 必须 userId-scoped,没有例外。
7. **Relative imports without extensions** (`moduleResolution: bundler`).
8. **No hardcoding** — magic numbers named; volatile/env-specific → env, stable domain → each package's `constants.ts`.
9. **Prefer mature, vetted libraries** — must pass the 4 gates (CF Workers, maintained, complexity-worth-it, no conflicts); record the choice.
10. **kebab-case filenames**; exports keep their own case convention (components `PascalCase`, funcs `camelCase`, types `PascalCase`, constants `UPPER_SNAKE`).
11. **UI = beUI (Framer Motion) 动效层 + 少量手搓本地原语,皆经 shadcn registry — 绝不 Radix** — beUI 件经 `@beui/*` registry(`pnpm dlx shadcn add @beui/<name>`)落 `packages/ui/src/components/motion/`,beUI 无对应的基础件(Card/Avatar/Separator/Skeleton)手搓;`@base-ui/react` 已移除、Base UI 全退场(见 [ADR 0004](docs/adr/0004-adopt-beui-motion-layer-drop-base-ui.md))。design tokens 优先(含 `lib/ease.ts` 动效 spring/easing token),避免任意值,不改件内核。**组件取材决策树(强制)**:① 优先 beUI 组件,或用 beUI/既有原语**组装**;② beUI 没有 → 查 shadcn(非 Radix)可用组件,**告知用户**后再用;③ 两者都没有 → **告知用户 + 提方案**(通常手搓 token-only 本地原语,类比 Card/Avatar/Separator/Skeleton),经用户确认后再动手。安装**「用到再加」**——依赖各归首用切片,不提前引入。**绝不自定义颜色/样式,只引用 design token**(数据可视化 SVG 是唯一例外,颜色仍只走 `--chart-*`/语义色 token)。
12. **Small commits, English messages — never `git commit` without explicit approval** ("提交"/"commit" authorizes it; "执行"/"go" does NOT).

## Package conventions (monorepo)
- **Packages are created on-demand by the phase that needs them** — not pre-stubbed. P1.2 creates `packages/core`, P1.4 `packages/db`, P1.5 `packages/ui`, each provider when built. The workspace globs in `pnpm-workspace.yaml` already cover `packages/*`, `packages/clients/*`, `packages/connectors/*`, `packages/oracle/*`(+ `upstreams/*`), `apps/*`, so new packages need no config change.
- **Internal-packages pattern**: each `@folio/*` package.json sets `"exports": { ".": "./src/index.ts" }` pointing at source — **no build step** for internal libs (Vite/Vitest transpile TS directly). Consumers depend via `"@folio/<x>": "workspace:*"`.
- **共享依赖的版本只在 `pnpm-workspace.yaml` 的 `catalog:` 里写一次**(#370),各包写 `"vitest": "catalog:"`。**判据:被 ≥2 个包依赖就进 catalog**;独一份的依赖照常写版本号(catalog 只会多一层间接)。新包加一个已在 catalog 里的依赖 → 必须写 `catalog:`,别复制版本号。**peerDependencies 不进 catalog** —— peer 范围故意比 dev 宽(`@folio/ui` 的 `react: ^19.0.0` 是唯一一例),收进去会把它收窄。改版本:改 catalog 一处 → `pnpm install`。
- **No TS project references** (overkill here); each package `tsconfig.json` just extends `../../tsconfig.base.json`.
- **Each package ships its own minimal `vitest.config.ts`** + a `test: "vitest run"` script. This keeps `vitest` from inheriting the root `projects` config when run inside a package, and lets the root runner (`pnpm test:packages`) discover the package. The root `vitest.config.ts` (`test.projects`) is the canonical all-package runner.
- **A provider serving multiple account types**: keep `BalanceProvider.accountType` singular; use a factory to emit one provider object per type (shared impl), export `providers: BalanceProvider[]`, and let `@folio/sync` flatten them into `buildRegistry` (方案 A).
- Package prefix `@folio/*`。上游客户端叫 `@folio/<upstream>-client`(`packages/clients/<upstream>`);`@folio/connectors-provider-<name>` 是**待退场的老形状**,别新建(ADR 0036)。

## Git & PR 工作流
- **功能开发走技能链**:think → grill-with-docs → ADR(难回退的决策)→ to-spec → to-tickets → 开分支 → implement(内驱 tdd)→ code-review。路由见 `/ask-matt`。
- **main 只经 PR 收代码**:动代码前从 main 开 `feat/*` 分支;直推 main 被禁。ADR 这类文档基线可先提交 main,代码走 PR。
- **合并用 Squash**:保留 GitHub 的 Verified 签名;**不要 rebase-merge**(会把提交变 Unverified)。
- **PR 正文关 issue**:每个都带关键字 + 英文逗号 —— `Closes #2, closes #3, closes #4`;别用中文顿号「、」或裸列表(不会自动关)。
- **提交已签名(GPG)**:别引入破坏 Verified 的操作。
- **每片 tracer-bullet 独立可验收**:一片一提交,过四闸(typecheck / test / biome / build)+ code-review 再进下一片。

## Toolchain notes (current best practices)
- **`wrangler.jsonc`** (not `wrangler.toml`) — Cloudflare's recommended format; some features JSON-only. Wrangler v4.
- **Vitest 4** with root `test.projects` in `vitest.config.ts` (`vitest.workspace.ts` is removed in v4). Glob `test.projects` at each package's **config file** (`packages/**/vitest.config.ts`), not at directories — a dir glob (`packages/*`, `packages/tokens/*`) also matches container-only folders (`packages/tokens`, `packages/providers`), which get picked up as unnamed, colliding projects and fail the whole run.
- **Cloudflare targeting via `@cloudflare/vite-plugin`** (not the legacy Nitro `cloudflare-module` preset).
- Package name is **`@tanstack/react-start`** (the old `@tanstack/start` is gone).
- TypeScript: `module: preserve` + `moduleResolution: bundler` (now the modern defaults) enable extension-less relative imports.
- **TypeScript 7** (the Go port) — `tsc --noEmit` on `apps/web` went 12.1s → 1.7s locally. Nothing in the build chain notices: vite/esbuild/rolldown **strip** types rather than check them, so `tsc` is only ever invoked by `pnpm typecheck`. What TS7 does cost: **no stable programmatic API until 7.1**, so tools that `import typescript` can't run — that rules out `typescript-eslint`, i.e. the "no type-aware lint yet" note below stays true by force, not just by choice. Nothing in the current dependency tree imports it (0 of 1287 installed packages declare `typescript` as a dep/peer), which is why the bump was config-only. Options TS7 dropped and we must never adopt: `baseUrl`, `downlevelIteration`, ES5 target, AMD/UMD/SystemJS, `moduleResolution: node/node10/classic`, `esModuleInterop: false`.
- **D1 testing**: `@cloudflare/vitest-pool-workers` 0.16.x — use the root `cloudflareTest` plugin + `readD1Migrations` (the old `defineWorkersConfig`/`/config` subpath is removed); `env`/`applyD1Migrations` from `cloudflare:test`; `Cloudflare.Env` augmentation in a test `env.d.ts`. This version doesn't isolate per-test storage → reset state in `beforeEach`.
- **D1 data layer**: D1 has no interactive `db.transaction()` → atomic multi-writes use `db.batch([...])`. **A batch is one implicit transaction executing its statements in order, so a later statement reads rows an earlier one wrote — and one failure rolls the whole batch back** (both verified on the repo's D1 test harness). That's stronger than "several writes go together", and it's the part that gets missed: a value that depends on the outcome of an earlier statement does **not** have to be computed in JS first — resolve it with a subquery inside the later statement. Concretely, inserting a content-deduped row (`ON CONFLICT DO NOTHING`) and then pointing at *whichever row survived* is one batch: `… VALUES (…, (SELECT id FROM t WHERE <dedup key> = ?))`. Reaching for read-then-write instead (SELECT the id in JS, branch, write) both loses atomicity and needs its own concurrency story — **check this behaviour with a throwaway probe before designing around a supposed limit**. D1 enforces FKs, so `ON DELETE CASCADE` works at runtime. Migrations: `drizzle-kit generate` (out=`drizzle/`) → apply (never `drizzle-kit migrate`); `out` == wrangler `migrations_dir` == test `readD1Migrations` path. **Applying**: migrate scripts live in **`apps/web`** (it owns the real `database_id` + `DB` binding + `migrations_dir`): `pnpm --filter @folio/web db:migrate:local` after a schema change, `db:migrate:remote` before deploy. **Must run from `apps/web`, not `packages/db`**: `packages/db/wrangler.jsonc` has a placeholder `database_id` + its own `.wrangler` (Vitest/Miniflare only), so an apply there hits the wrong DB — `--local` writes `packages/db/.wrangler` (≠ the running server's `apps/web/.wrangler`), `--remote` targets a bogus id. `@cloudflare/vite-plugin` *may* auto-apply `drizzle/` on dev-server startup but is unreliable across new migrations → after a schema change run `db:migrate:local`. **Miniflare keys the local D1 file off `database_id`, not `database_name`** — change that id (e.g. pointing at a freshly created remote DB per DEPLOY.md step 2) and the dev server silently gets a brand-new empty SQLite under `.wrangler/state/v3/d1/miniflare-D1DatabaseObject/`, with no user table, so every request dies on `Failed to get session`. Verified by doing it: swapping the id created a second 4 KB file and broke the running server; swapping back restored it. After such a change: `db:migrate:local`, then re-register a user. `db:generate` stays in `packages/db` (schema owner). Tests apply via `readD1Migrations`, independent of both. **Column renames need a TTY**: `drizzle-kit generate` prompts "created or renamed?" per column and hard-errors headless (no TTY) — drive it with `expect` (spawn `pnpm db:generate`, on each "created or renamed from another column" send down-arrow `\033[B` + `\r` to pick "rename column"). Renaming a PK column → SQLite can't `ALTER`, so drizzle emits create-new-table + `INSERT…SELECT` + drop + rename (data preserved); a non-PK column gets a plain `RENAME COLUMN`.
- Generic `Uint8Array<ArrayBufferLike>` isn't assignable to Web Crypto `BufferSource`/`D1` BufferSource — annotate byte arrays as `Uint8Array<ArrayBuffer>` when needed. (Still true under TS7: dropping the annotation in `connectors/basic/src/crypto.ts` reproduces the same `TS2769`, so this is a `lib.d.ts` rule, not a TS6 quirk.)
- **better-auth on CF Workers** (1.6+) — platform-forced gotchas, **different root causes, don't conflate**:
  - **scrypt**: native `node:crypto` auto-selected with `nodejs_compat` → no hash override needed (pre-1.6 pure-JS scrypt caused intermittent Error 1102 CPU-limit).
  - **single module-level auth instance**, lazy-init by `env` from `cloudflare:workers`: a *per-request* instance → D1/SQLite write-lock contention → ~33s local-dev hang + prod 503 cascade. One instance kills both.
  - **`ctx.waitUntil` for post-response work** (token cleanup / session writes): the Worker exits before they finish otherwise → `Network connection lost`.
  - **secondaryStorage TTL ≥ 60s**: some endpoints pass 10s, below KV's 60s min → silent failure (`Math.max(ttl, 60)`).
  - **disable cookieCache**: cookieCache + secondaryStorage has an upstream bug → take one extra D1 read/request for correctness.
  - **no auth calls at module load**: Worker startup-CPU limit → keep all auth calls inside handlers/server fns.
  - `@better-auth/cli` (1.4.x) lags better-auth (1.6.x) and fails under this repo's jiti (stale `better-call`) → hand-define the Drizzle auth schema per the official spec. Verify via curl with `Origin: http://localhost:3000` (CSRF guard).
- **TanStack Start server routes**: `createFileRoute("/path/$").server.handlers` (GET/POST → `Response`). The `server` option is a Start augmentation of `@tanstack/router-core`; since app `src` doesn't import `@tanstack/react-start`, add `/// <reference types="@tanstack/react-start" />` (in `src/env.d.ts`) so `tsc` sees it. Run `wrangler types` after editing `wrangler.jsonc` bindings → `worker-configuration.d.ts` (Biome-excluded).
- **Tailwind v4 in the pnpm monorepo**: v4 doesn't scan `node_modules`, so workspace packages (symlinked there) are invisible → use **`@source`** pointing at the **real source paths**: `@folio/ui` `globals.css` has `@source "../**/*.{ts,tsx}"` (scans ui src), `apps/web` `styles.css` has `@source "./**/*.{ts,tsx}"`. Missing it = "compiles but renders unstyled". Don't `@source "../node_modules/..."` (fails to resolve under pnpm). `@folio/ui` owns the Tailwind entry + theme tokens; `apps/web` just `@import "@folio/ui/globals.css"`.
- **Lint/format = Biome** (`biome.json`, 2.x): `pnpm lint` (check) / `pnpm lint:fix` (write); CI runs `biome ci`. **两边都带 `--error-on-warnings` —— warning 就是红**(#427:少了它 warning 一路放行,堆到 13 条没人管)。**`linter.domains` 显式写死 `react`/`test`,不靠 biome 自己嗅**:domain 规则(react 的 `useExhaustiveDependencies`/`noArrayIndexKey`/`noDangerouslySetInnerHtml`,test 的 `noFocusedTests` 等)默认要「探测到 `react@>=16` 这样的依赖」才启用,而本仓 `react`/`vitest` 在 package.json 里写的是 `"catalog:"`(#370)—— 匹配不上,**整组规则静默关闭**。症状很像「注释过期」:代码里的 `biome-ignore` 一条条变成 `suppressions/unused`,顺手删掉正好把最后的痕迹抹平。**另:`biome-ignore` 必须是紧贴代码那行的单行注释** —— 解释写在它上面的普通注释里,续在它下面几行会让抑制失效。Style: 2-space, double quotes, lineWidth 100. Excludes vendored/generated (`@folio/ui` `components/`+`styles/` — beUI/motion primitives, `routeTree.gen.ts`, `drizzle/`, `worker-configuration.d.ts`, all `*.css`); `.gitignore` reused via `vcs.useIgnoreFile`. `noNonNullAssertion` is off in test files only. No ESLint (no type-aware lint yet; `tsc --strict` covers types).
- **Dead-code guardrail = knip** (`knip.json`, 6.x): `pnpm knip` locally; CI runs it in `verify` (biome → typecheck → **knip** → test → build) → **unused files / exports / dependencies fail the PR**, so review never has to guess "is this still used?". When knip flags an export, resolve it — delete if fully unused, or drop the `export` keyword if it's only used within its own file (don't add a bogus consumer to silence it). `knip.json` only silences **structural false positives** knip can't see statically: the `cloudflare:workers`/`cloudflare:test` virtual modules (not npm packages), `tailwindcss` referenced from CSS `@import`/`@plugin`, and `wrangler` used only by Miniflare/vitest-pool-workers. **Never add a real dead export/file/dep to `ignoreDependencies`/`ignore` to dodge a red CI** — that defeats the guardrail; fix the code instead.

## Security model
- Global provider keys (`ZERION_API_KEY`, etc.) → CF Secret/env. Per-account creds → D1 as one `creds` map (physical column `enc_credentials`), encrypted **per field by `type`**: `secret` fields AES-GCM with `SECRETS_KEY`, `public`/`semi` plaintext (P6.6.1/P6.6.2; seal/open/safeView/isComplete now in `apps/web/src/lib/core/creds.ts`, driven by `@folio/balances` `credentialSpecs()` + Web Crypto).
- Read-only tracking, **no signing** → no private-key field in any `provider.inputs`; on-chain accounts store address/xpub only (`public`).
- Decrypt (`openCreds`) only inside server functions / sync at fetch time, discard immediately, never log (P6.7 red line: log only accountId/type/code/counts).
- **数据一律按用户隔离**,`@folio/db` 的每个 op 都按 userId 作用域(原则 #6)。**作用域怎么加是有讲究的**(ADR 0037):参考层与 `queries/` 已迁的领域都是 **per-user layer 在装配时吃掉 userId**,方法签名里没有 user 参数;`queries/` 未迁的那半仍是签名里收 userId。两种都合规 —— 判据是「这个 op 有没有『谁的』这回事」,不是「userId 在不在签名里」。**两张表除外**:`global_token_ref_index` 与 `token_daily_prices` —— 它们只装上游的公开知识,泄露面为零,所以不隔离也不是风险。判据是「表里有没有『谁的』这回事」,不是「这张表大不大 / 共用起来省不省」。参考层其余部分(代币行、ref 行、per-user 缓存)**全部** per-user,userId 在装配那一层就被吃掉(`runOracle(userId, …)` 按 userId 现建 per-user 的 store layer),服务的方法签名里一个 user 参数都没有 —— 拿错用户在编译期就发生不了。
- better-auth CF gotchas (apply in P2.1): native `node:crypto` scrypt hash override; single module-level auth instance; `ctx.waitUntil` for background tasks; secondaryStorage TTL ≥ 60s; disable cookieCache; no auth calls at module load.

---

## Progress

**M1–M6 complete** — foundation → on-chain → CEX → perp → polish, deploy-ready (see [apps/web/DEPLOY.md](apps/web/DEPLOY.md); going live is user-run per safety rules). Shipped-work history lives in git log + [docs/adr/](docs/adr/) — no in-repo phase archive.

**前向路线**:见 **[docs/roadmap.md](docs/roadmap.md)**(叙事 / 范围 / 依赖,并链到 epic 看板 GitHub Project;看板是进度事实源)。规划 epic **不打 `ready-for-agent`**;开工某条时经技能链(grill → to-spec → to-tickets)拆竖切片才给 agent-ready 标签。规划草稿(plans)写本地 **`.scratch/plans/`**(gitignore,一次性、不入库);耐久产出落 ADR + Issues,不留 plan 文件在仓库。

---

## Agent skills

引用的工程技能(`/ask-matt`、`/grill-with-docs`、`/implement`、`/code-review` 等)经 **`npx skills@latest add mattpocock/skills`** 安装到 `.agents/skills/`(gitignore,不随仓库分发,按开发者各自安装)。仓库只带**配置**(下方 + `docs/agents/*`,由 `setup-matt-pocock-skills` 落地)。

### Issue tracker

GitHub Issues (repo `x0finch/folio2`), via the `gh` CLI. External PRs are **not** a triage surface. See [docs/agents/issue-tracker.md](docs/agents/issue-tracker.md).

### Triage labels

Five canonical roles, default names: `needs-triage` / `needs-info` / `ready-for-agent` / `ready-for-human` / `wontfix` (created on first use). See [docs/agents/triage-labels.md](docs/agents/triage-labels.md).

### Domain docs

Single-context: one `CONTEXT.md` + `docs/adr/` at the repo root. See [docs/agents/domain.md](docs/agents/domain.md).
