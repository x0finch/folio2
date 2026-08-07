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
- **Outbound HTTP — 两套规矩,按包分**:
  - **Effect 包**(`packages/clients/*`、`sync`,以及后续迁过去的):走 `@effect/platform` 的 `HttpClient`,见下面的 [Effect](#effect) 一节。**别在 Effect 包里直接调全局 `fetch`** —— 那样拿不到 `AbortSignal`,上层超时之后请求还在飞。
  - **尚未迁移的包**:`await fetch(url, { headers })` 直接调全局。Never stash fetch on an object / inject a `fetchImpl` seam and **call it as a method** (`deps.fetchImpl(url)`) — `this` becomes that object and CF Workers throws `Illegal invocation` (and then needs a `bind` patch). Mock it in tests with `vi.spyOn(globalThis, "fetch")` + `afterEach(() => vi.restoreAllMocks())`.
    **裸函数调用不在此列**:`const f = globalThis.fetch; f(url)`(`this === undefined`)在 workerd 上是放行的 —— 实测两种调法给的都是同一个 `Invalid URL`,没有 `Illegal invocation`。这条要紧,因为 `@effect/platform` 的 `FetchHttpClient` 内部正是这么调的;`apps/web/tests/server/outbound-workerd.test.ts` 在真 workerd 里钉住它。
  - 两边共同的那条判断仍然成立:**运行时全局(fetch / crypto / clock)不该在生产签名上开一个只为测试存在的注入参数**。区别只在「换成什么」——非 Effect 包换成 mock 全局,Effect 包换成一个**服务**(`R` 通道,不是 config 字段)。
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

## Effect

迁移进行中(ADR 0035:`sync` → `connectors` → `shared` → `clients` → `oracle` → `db`,前端明确不碰)。
下面是 `@folio/sync` 和 `packages/clients/*` 两站踩出来的,**每条都对应一次返工**。

### 依赖与替换点

- **能替换的东西一律是服务,不是 config 字段。** 出网、缓存后端、签名器、限频档位 —— 都用
  `Effect.serviceOption` 读的**可选服务**,`R` 通道不受污染(不 provide 也能跑),生产走默认、
  测试 provide 一个假的。
  **判据是「生产会不会传它」**:只有测试传的字段,就不该是字段。
  代价是实打实的 —— `rateLimitScope` 当初是 config 字段,四个 client 各写一遍
  `config.rateLimitScope ?? "isolated"`,于是**默认值有五个地方定义**,而且跟模块自己的默认值打过架:
  真正的默认藏在调用点里,读那个模块是看不出来的。
- **别在 config 对象上挂回调。** 一个回调字段就是一步流水线在伪装成配置 —— 它让「这件事会失败成什么」
  离开类型、让读的人必须先知道有这么个钩子。本仓三个回调(`toFailure` / `checkBody` /
  `classifyOverride`)先后都改成了调用点上看得见的 `pipe` 一步。
  **例外是真正的效应式依赖**(算签名头:会失败、要 IO)——那不是配置,是依赖,留着。
- **别为了形状统一假装需要 `Scope`。** 没有闸就没有 scope,`make` 就返回纯值而不是 Effect
  (hyperliquid 就是)。`Layer.succeed(tag, make(config))` 对纯值是**立即求值** —— 那种情形用 `Layer.sync`。

### 错误

- **错误类型按「消费者要区分什么」划分,不按上游/模块划分。** 七个上游共用四类 tagged error
  (凭据 / 限流 / 够不到 / 读不动),因为消费者(适配层)对七家是同一个,它要做的判断永远是这四个。
  各定一套的代价是 7 套同构错误类 + 7 份几乎一样的下游映射。
  上游之间的真实差别是**怎么归类**,不是**分成哪几类** —— 那部分一家一行,写在那家自己的包里。
- **判 `_tag`,不判 `instanceof`。** 后者额外要求两个类来自同一个模块实例 —— 那是包管理器的事,
  不该是正确性的前提。
- **重试属于「一次完整业务操作」那一层,不属于「一个 HTTP 请求」。** 本仓的重试在 `@folio/sync`:
  它包的是「取一次余额」含超时。两层各退避 3 次就是 9 次。请求层只负责把错误分对类。
  推论:**闸(限频)必须在重试的内层** —— `Effect.retry` 重跑整个 effect,闸在里面,语义自动正确,
  不需要包替调用方保证。

### CF Workers 上的状态

- **模块级可变状态在这里是刻意的,不是偷懒。** 每个请求一次 `runPromise`,而 **Layer memoisation 是
  per-run 的** —— 状态放 `Scope` 或 Layer 里就等于每请求重置。跨请求要活的东西(限频游标、
  近静态数据的缓存)只能在模块级。
- **同理:官方那些「状态绑 Scope」的组合子在这里会静默失效。** `RateLimiter`(semaphore + 后台
  refill fiber)、`Cache` / `cachedWithTTL` —— 类型上能用,运行时每请求一份新的,等于没有。
  用之前先问:**它的状态活在哪?**
- 反过来,这也意味着「改成每 isolate 一个 `ManagedRuntime`」这条路**要先验证**:Workers 有
  「不能替另一个请求做 I/O」的限制,跨请求存活的 fiber / timer 可能直接抛。

### 用官方的东西之前,先读它默认记了什么

**采用一个库就是采用它的默认值。** `@effect/platform` 的 `HttpClient` 内建 span 默认把**完整 URL、
query 和全部请求头**写进属性,而它的默认脱敏名单(`["authorization","cookie","set-cookie","x-api-key"]`)
不含本仓六个凭据头;它还默认往出站请求注入 `traceparent`。我们的 query 里有 HMAC 签名和钱包地址 ——
直接用就是原则 #5 的红线。

- **安全属性写在「用的地方」,不写在装配处。** 第一版把加固写在生产 layer 上,红线测试当场打回:
  任何自己 provide 一个客户端的调用点(每个测试都是)拿回的都是没加固的。
  **安全属性不能靠「记得用对那个 layer」保证。**
- **记什么走白名单,不走黑名单。** 上游将来加一个新属性,黑名单要跟着改,白名单不用。
- **红线要有测试钉住**,而且是断言「**没有**什么」:span 里没有 query、没有头名、出站没有 `traceparent`。

### 测试

- **时序测试用 `TestClock`,断言精确值。** 有了虚拟时钟就不必再赌墙钟,也不必设宽窗口 ——
  上面 [Tests](#tests) 那条「别断言墙上时钟」在 Effect 包里的答法就是它。
- **但 `TestClock` 管不到 Effect 调度器之外的东西**:假 fetch 的 `Promise.resolve`(微任务)、
  Node 上 `crypto.subtle`(线程池,是**宏任务**)。前者 `Effect.repeatN(Effect.yieldNow(), n)` 能冲掉,
  后者冲不掉 —— 涉及它的用例别写 fork + poll,改成**跑到底再问虚拟时钟走了多远**
  (走了 0ms 就是一发都没等过,与调度快慢无关)。
- **`TestContext.TestContext` 的 `Random` 不是确定的**(实测四次:437.9 / 139.8 / 386.4 / 280.9)。
  别在注释里说它是。
- **测试装配收成一份共用工具,别每包手抄。** 抄九遍的东西每份都会慢慢长歪 —— 本仓实测:
  有几个包漏了 provide 限频档,于是一直偷偷跑在模块级共享游标的那一档上,跨用例串味。
- **Tag / Layer 那条路要单独有测试。** 生产只走它,而「测试全走 `make`」时它可以长期零覆盖
  (本仓 12 个测试文件里一次都没走过)。
- **`@effect/vitest` 现在装不了**(2026-08):稳定版 `0.30.0` peer 是 `vitest ^3.2.0`(本仓 4.x),
  支持 vitest 4 的 `4.0.0-beta.x` 要求 `effect ^4.0.0-beta`(本仓 3.22)。硬装能跑(验过),
  但要写一条「忽略 peer 冲突」并一直挂着。**别再重新评估,除非 Effect 4 稳定了。**

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

- **情景测试:按用户走一遍,每个情景查三处。** 单元测试各测一个函数,挡不住「跨边界传错值」——
  边界两侧各自的用例都绿,而中间那一跳没人看。所以每条用户可见的路径要有一条从头走到尾的测试,
  查这三处:**① 入库了吗(几行、挂了哪些 ref) ② 库里的值对不对 ③ 屏幕上那一行是什么**。
  参考 `apps/web/tests/server/scenarios.test.ts`(手动选币 / 手动输入 / 链上同步)。
  - **驱动真链路**:真 D1、真编排器、真展示组装(照抄 server fn 那几行,不复刻业务逻辑 ——
    复刻的话顺序一改测试还是绿的)。只打桩「取数」与「出网」。
  - **夹具绕过被测代码 = 断言是空的。** 这是本仓真实漏掉三个 bug 的原因,每次都是同一个形状:
    ① 缓存是空的 → 「我们没去问」和「问了没查到」长得一样;② 手写 `putInfo` 直塞 → 把要测的
    刷新函数整个绕开;③ 只 seed 了新层 → bug 在旧层。**写完一条用例,把被测那行改坏,确认它会红。**
  - 对抗性夹具:要验「不该借别人的东西」,就得先把那个「别人」摆上去,而且**摆在它真会去问的那一层**。

- **测试的默认配置要便宜,贵的那档得靠结构自己选中。** apps/web 45 个测试文件里 44 个测的是纯算术,
  却每个都先搭一套假浏览器(jsdom 凭空造 `document`/`window`,**每文件**约 0.5s)——25 秒的环境准备,
  换 0.4 秒的断言。修法不是「记得给纯逻辑测试标 node」,而是让**文件后缀**决定环境:
  `*.test.ts` → node,`*.test.tsx` → jsdom(见 `apps/web/vitest.config.ts`)。组件测试要渲染 JSX、
  本来就得是 `.tsx`,所以贵的那档**只能被结构选中**,不依赖谁记得写 `// @vitest-environment` 那行注释。
  同理别把它「简化」回单个 `environment` 设置 —— 那等于把默认值调回贵的那档。
  - **这类错误的形状:默认值贵,而且贵在没人看的地方。** 总时长只报「7 秒」,不报这里面 25 秒(累计)
    是在造环境。所以读 vitest 的 `Duration` 那行要看**括号里的分解**(transform / setup / import /
    tests / environment):哪一项跟 `tests` 差一个数量级,那儿就是问题。1121 个测试真正跑断言只有 5 秒,
    别一看慢就想删用例 —— **先看时间花在哪,再决定砍什么**。

- **别断言墙上时钟(会 flaky)。** 限频 / 重试这类测试**绝不**收集 `Date.now()` 再断言分组
  (`new Set(at).size === 1`、`Math.max(...at) === 0`、逐发间距 `> X`)—— CI 一负载,请求的异步链
  (签名 HMAC、header、parse)就在时钟推进之间被切开,同一批落到不同刻,偶发红(实测咬过 okx no-gate、
  shared workerd 各一次)。改成**确定性**的判法:
  - **有闸**:假时钟 + 按**条数**断言。`await vi.advanceTimersByTimeAsync(0)` 只冲微任务不推进时钟 →
    数「这个窗口出去了几发」(= burst);再 `runAllTimersAsync()` 把被闸住的放完 → 数总数。
    (参考 `providers/{zerion,coinstats}/tests/rate-limit.test.ts`、binance 的 `countOf`。)
  - **无闸**:假时钟,**直接 `await Promise.all(...)` 不推进时钟** —— 没闸就没有 `setTimeout` 等待,
    全靠微任务/异步 resolve、时钟没动 → 全落同一刻;有闸的话反而会卡在 `setTimeout` 上超时报红,
    正好也抓住「谁给它加了闸」。(参考 `providers/{okx,hyperliquid}/tests/no-gate.test.ts`。)
  - **真要在 workerd 里验真定时器**(`shared/tests/server/workerd.test.ts`,故意用真时钟):只设**下界**
    (`elapsed >= interval * N` —— 负载只会更慢,顶不穿),绝不设**上界**(`< interval`,一负载就破)、
    也不断言逐发间距;判「等没等」优先用注入的 `sleep: async (ms) => { waited = ms }` 记毫秒,不看墙钟。

## Debugging

- **Don't guess — add logs + make a real request.** Add structured logs (`getLogger(["folio", …])`), run the real path, read the actual error/`cause`, then fix the root cause.

## Commits

- Small commits, **English** messages, conventional-commit style (`type(scope): summary`). Never `git commit` without explicit approval.
