# Coding Style

Coding conventions for Folio. Consolidates the coding-related rules from [CLAUDE.md](CLAUDE.md)
(which remains the authority on architecture, security, and process) plus front-end/React style.

## General

- **Relative imports, no extensions** — `import './foo'` (never `./foo.js` / `./foo.ts`). `moduleResolution: bundler`.
- **kebab-case filenames** (`token-combobox.tsx`); exports keep their own case: components `PascalCase`, funcs/vars `camelCase`, types `PascalCase`, constants `UPPER_SNAKE`.
- **No hardcoding** — chain IDs, API bases, timeouts, TTLs, limits → `constants.ts` or env. Name every magic number; volatile/env-specific → env, stable domain → `constants.ts`.
- **Prefer mature, vetted libraries** over hand-rolling (signing, BIP32, crypto, dates, decimals). A new lib must pass 4 gates: ① runs on CF Workers, ② maintained/no severe CVEs, ③ complexity matches payoff, ④ no conflicting deps. Record the choice.
- **Secrets never leave / never logged** — APIs return only a safe projection; decrypt only at use time and discard.

## Implementation shape

- **Functional factories, not classes.** Stateful implementations are closures: `createXxx(config): Interface` — the closure holds state and returns an object of methods (like `createTokenStore` / `createCoinGeckoSource` / `defineProvider`). No `class` / `this`.
- **Stateless logic → top-level functions with explicit deps.** Pull pure IO/logic out as module-level functions that take their dependencies as parameters (`request(http, path)`), not hidden behind `this`/closures — easier to test and reuse.
- **Outbound HTTP: call global `fetch` directly.** `await fetch(url, { headers })` (same as every provider). Never stash fetch on an object / inject a `fetchImpl` seam and call it as a method — that drops the global `this` and throws `Illegal invocation` on CF Workers (and then needs a `bind` patch). Mock it in tests with `vi.spyOn(globalThis, "fetch")` + `afterEach(() => vi.restoreAllMocks())`. Generally: when a dependency is a runtime global (fetch / crypto / clock), mock the global in tests instead of adding an injection param to production code.
- **Facades expose intent, not primitives.** A package's public interface offers domain-intent methods (`priceOf` / `enrich` / `warm`), not its internal collaborators (`.store` / `.provider`). Orchestration — cache→fetch→write, single-flight, TTL gating, ref construction — lives *inside* the instance; callers express *what* they want, never *how*. Smell: app code doing `store.getX` → `provider.fetchX` → `store.putX`, or building the module's own value objects by hand. Corollary: let callers pass raw identity (`AssetRef.coinId`) and construct the internal ref (`TokenRef`) for them — don't leak the constructor.
- **Bind ambient env once, at a single call site.** A factory like `createDb(env)` / `createTokens(env)` should be invoked in exactly one server-only module; everything else imports the ready instance (`import { db }` → `db.xxx`), never re-calls the factory. The single binding point is a `Proxy` that builds the facade per access from the `cloudflare:workers` env — deferring the env read to call time (request/scheduled), not module load.
- **客户端打包的代码只从"契约/basic"包引类型与 schema,绝不从"entry/门面"包引。** entry 包(如 `@folio/connectors`)经其 registry `import` 全部 provider 实现;任何被客户端组件引用的文件(`apps/web/src/lib/*`、组件)只要 **value-import** 它,就会把整张 provider 依赖图打进 client bundle —— 轻则体积膨胀,重则某 provider 的 server-only dep(`cloudflare:workers` 等)直接破坏 client build。契约(`Balance` / `CredField` / 各 `*Meta` schema)一律从 `@folio/connectors-basic` 取;registry / provider / manifest 只在 server 侧(sync)用。同理适用于其它 basic/entry 分层的包。
- **别造无逻辑的转发。** 一个函数如果只是把参数换个形状递给另一个函数,它就不该存在 —— 直接调那个函数。
  ```ts
  // ✗ 只是把两个参数装成对象
  const refOf = (namer: string, localName: string) => formatTokenRef({ namer, localName });
  // ✗ 只是换个名字
  export function normalizeNamer(s: string) { return normalize(s); }
  // ✓ 直接调;要换名字就把原函数改名,别再包一层
  formatTokenRef({ namer, localName });
  ```
  转发层的代价不是那一行,是**读的人多一跳**:看见 `refOf` 得先跳进去才知道它跟 `formatTokenRef` 是同一件事,而跳完发现什么都没发生。名字还会分叉 —— 同一件事在仓里长出两个叫法,grep 一个漏一个。
  **有内容就留着**,判据是「它有没有做决定」:绑定了一个常量(`cgkRef` 固定 `CGK_VENDOR` 并小写归一)、闭包住了状态(store 的 `mk` 绑 `source`)、加了一档判定(`partsOf` 把 `unknown` 映射成 `undefined`)—— 这些都不是转发。
  同理**别为了「统一入口」把两三处一样的调用抽成 helper**:重复三次 `formatTokenRef({...})` 是三次同样清楚的调用,抽出来只是多一个要维护的名字。真要抽,得先有一句它自己的逻辑。

- **快回退降嵌套(guard clause)。** 前置判定(缺凭据 / 分派选路 / 校验失败 / 找不到目标)一律 early-return 或提前抛,不把主逻辑塞进 `if (ok) { … }` 的深层嵌套。**分派型函数只做"选路 + return"**(如 sync 注入的 `fetchBalances`:`if (connector) return fetchViaConnector(…); return fetchViaBalances(…)`),各分支实现抽成独立命名函数;一个函数里与其主职责无关的前置工作,提到独立函数。
- **Server-only deps (`cloudflare:workers`, node built-ins) belong only in code that gets stripped from the client.** A module imported client-side (e.g. one exporting a `createServerFn`) may reference `cloudflare:workers` *only inside the server-fn handler* (the compiler strips it). A **plain exported function** in that same module referencing the env can't be tree-shaken out → breaks the client build (`Rolldown failed to resolve "cloudflare:workers"`). Fix: move such functions into a separate server-only module the client never imports; the client-facing module references them only from within the stripped handler.

## UI

- **beUI (Framer Motion) motion layer + a few hand-rolled primitives — never Radix, never Base UI** (ADR 0004). `@base-ui/react` and `radix-ui` are not dependencies and must not be reintroduced. Colors/spacing/radius via design tokens (`bg-background`, `text-foreground`, …), motion via the `lib/ease.ts` spring/easing tokens — no hardcoded colors, no arbitrary values (`bg-[#…]`, `p-[13px]`), no editing component internals.
- **beUI primitives are added via the shadcn CLI + beUI registry, never hand-written** — `pnpm dlx shadcn@latest add @beui/<name>` → lands in `@folio/ui` `src/components/motion/` (export from `src/index.ts`). Basics beUI lacks (Card/Avatar/Separator/Skeleton) are hand-rolled as ~a-dozen-line local primitives; blocks/compositions live in `apps/web/src/components/` (hand-authored). A new transitive dep from `add` → run the 4 library gates.
- **Use a component's native API, don't be clever.** Prefer controlled props / built-in behavior (`value`, `open`, `filter`, `openOnInputClick`, …) over hand-rolled overlays, focus hacks, or pointer-event tricks. Extend on top of the native structure, minimally.
- When unsure what a component supports, **read its types / the `shadcn add` output — don't guess.**

## React

- **Data fetching → `useQuery`, not `useEffect`.** The app is TanStack Start with react-query wired in (`router.tsx`: `QueryClient` + `setupRouterSsrQueryIntegration`). Never build fetches from `useEffect` + `useState` status flags.
  - Debounce with `useDeferredValue` (as the `queryKey`), not `useEffect` + `setTimeout`.
  - Derive with `useMemo` / inline; don't `useEffect` → `setState` to sync derived state.
  - Reserve `useEffect` for genuine one-off side effects that can't live in an event handler.

  ```tsx
  const search = useDeferredValue(query.trim());
  const q = useQuery({
    queryKey: ["tokens", search],
    queryFn: () => (search ? searchCoins({ data: { query: search } }) : topCoins({ data: {} })),
    enabled: open,
    placeholderData: keepPreviousData,
    staleTime: 60_000,
  });
  ```

- **Lift conditional JSX into named variables**; keep the returned tree flat. Don't inline `cond && (<big block/>)`.

  ```tsx
  const isSelectedAndClosed = value !== null && !open;
  const selectedOverlay = isSelectedAndClosed ? <SelectedRow … /> : null;
  const dropdownBody = q.isError ? <ErrorRow /> : q.isLoading ? <LoadingRow /> : <TokenList … />;
  return (<Combobox …>{selectedOverlay}<ComboboxContent>{dropdownBody}</ComboboxContent></Combobox>);
  ```

- **Extract stateful sub-views into named components** (same file) — loading / error / empty branches that have their own structure become `TokenListLoading` / `TokenListError` / `TokenListEmpty`, not inline blocks. Factor shared layout (e.g. a centered `StatusBlock`) so the states stay visually consistent.

## Naming & consistency

- One concept, one word across the codebase (e.g. `token` everywhere — `TokenCombobox`, `TokenRow`, `TokenInfo` — not mixed `coin`/`token`).
- **One situation, one way.** Before writing a new implementation, check how sibling ones (providers / sources / stores) do it and follow that pattern; deviate only with a clear reason.

## Tests

- **Test-first**: adapters get tests against recorded fixtures before impl; parsing logic gets golden tests. Tests in `tests/` beside `src/`, fixtures in `tests/fixtures/`.
- Vendored beUI primitives are not unit-tested — validate integration (build emits their classes); test our own logic (compositions, hooks, pure functions).

## Debugging

- **Don't guess — add logs + make a real request.** Add structured logs (`getLogger(["folio", …])`), run the real path, read the actual error/`cause`, then fix the root cause.

## Commits

- Small commits, **English** messages, conventional-commit style (`type(scope): summary`). Never `git commit` without explicit approval.
