# Coding Style

Coding conventions for Folio. Consolidates the coding-related rules from [CLAUDE.md](CLAUDE.md)
(which remains the authority on architecture, security, and process) plus front-end/React style.

## General

- **恒无扩展名;`apps/web` 内跨树用 `@/`、同目录用 `./`** — 永不写 `./foo.js` / `./foo.ts`(`moduleResolution: bundler`)。`apps/web` 里凡是 `../` 起步的跨目录引用一律 `@/lib/core/…` / `@/components/…`(`@/*` → `apps/web/src/*`),同目录邻居保留 `./token-search` 那个「就在旁边」的信号(#497)。**只有这一个别名**(等价的 `#/*` 已删)。落在 `src/` 外的目标(如 `../public/sw.js`)别名表达不了 → 照旧相对。`packages/*` 没有别名,全相对。
  - 别名要在**每一处解析器**各开一次:`vite.config.ts`、`vitest.config.ts` 的**每个 project**(顶层 `resolve` 不下传)、`vitest.workers.config.ts`,都写 `resolve: { tsconfigPaths: true }` —— 三条链互不继承,少一处的症状是 `Cannot find package '@/…'`(#497 探针实测)。
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

- **`apps/web/src/lib` 分层,判据是「客户端能不能用它」,不是「它碰不碰 env」**(#179 立的规矩,这里补上判据):
  - `lib/core/*.ts` —— 客户端**真的可以** import 的纯件(纯推导、视图形状、跨端共用的领域计算)。
  - `lib/hooks/*.ts`、`lib/i18n/*.ts`、`lib/queries/*.ts` —— 客户端专用的那几类,按用途分目录。
  - `lib/server/<资源>/index.ts` —— `createServerFn` 资源面,**只做装配**:每个 fn 一段 `createServerFn({method}).middleware([requireAuth]).validator(schema).handler(handleXxx)`,类比 route 文件只剩 route 配置。**客户端只准 import 这一层**(外加任何位置的 `import type`,见下条)。middleware 是「面」的契约,留在 index;**入参 zod schema 与 handler 同住动作文件**(单一定义,index `import { Input, handleX }` 后 `.validator(Input).handler(handleX)`;跨 fn 共享的 schema 住主人家、别人跨借)—— client 编译会把 `.validator()`/`.handler()` 的参数一并擦掉,schema 与 server-only 代码同文件不泄漏(#500 探针实证:zod 错误文案只在 dist/server)。handler 是普通 async 函数,`{ data, context }` 用 `z.infer<typeof Input>` 或语义类型自声明(不引 TanStack 类型),**可直接单测**(体内调 `getRequestHeaders`/`setCookie` 那几个的除外 —— 它们要 TanStack 的请求 ALS 上下文,直调会抛);与 validator 对不上时 `.handler(handleX)` 那行编译期报错。**零逻辑 handler 例外**:不收 data/context、纯转发一个现成函数的(connectors 那两个),直接内联 `.handler(() => xxx())`,别为它造转发文件(见「别造无逻辑的转发」)。Start 编译器把 handler 及其 import 链从客户端 bundle 剥离,具名跨文件引用与内联同待遇(#499 探针实证)。
  - `lib/server/` 其余一切 —— 只有服务端能跑的实现层:资源目录里的 handler 文件与私有 helper、无 index 的域库目录(`manual/`、`logos/`、`io/`、`entry/`)、顶层基座散件(`oracle.ts`/`creds.ts`/`effect-log.ts`),装的是 env/单例装配、领域核心、warmer、route helper,**以及任何 `import { Effect }` 的东西**。(#499 撤掉了曾经的 `internal/` 目录:「客户端不能碰」这道墙由“资源面即 index”来当,不再靠一层名叫 internal 的文件夹。)**带 node-env 单测的纯 helper 不与 handler 同住一文件** —— handler 几乎都引 oracle → `cloudflare:workers`,同住会把纯单测拖进 workers 链;同名让位时 handler 文件用 verb-noun(`sync/get-status.ts`,纯读模型 `status.ts` 不动)。workers 池测的 helper 无此限制,handler 可同住(`portfolio/account-holdings.ts`)。
  判据要按「能不能」而不是「碰不碰 env」,是因为按后者判会把一批 DI 写法的纯模块留在共用层 —— 它们不碰 env,却要 oracle 服务,客户端一辈子供不上。留在那儿只有打包时的摇树在拦,而摇树是优化不是保证。

- **`lib/` 顶层不放文件 —— 一个模块要么住进上面某个目录,要么住进它唯一的使用者。** 曾经的顶层是个 47 文件的杂物层:一多半只有一个 route 或一个 server fn 在用,却因为「像是个工具」被摆在全站可见的位置。只有一个使用者的,搬到使用者身边去。

- **准入 `lib/core/` 的判据是「有没有第二侧在**调它的代码**」——`import type` 不算。** 类型引用在编译后完全消失,不会把任何服务端代码带进 client bundle(要防的一直是 value-import,见上一条)。所以「逻辑全在服务端、页面只要个数据形状」的模块**不是共用件**,它该跟着逻辑住 `lib/server`(对应资源目录,或顶层基座件如 `creds.ts`),页面照常 `import type` 拿形状。
  这条是踩出来的:第一版按「有人引就算共用」摆了 15 个进 core,其中 `tokens` / `aggregate` / `creds` / `sync-status` 四个的**全部函数调用点都在服务端**,页面一行都没调 —— 它们是被自己的类型绑在共用层的。
  - **拆一个混合模块时,缝在职责上,不在 client/server 上。** `history` 看着像「服务端建曲线 / 客户端画曲线」,但 `downsampleSeries` 两边都调 —— 真正的缝是**采样**(共用)与**从快照重建**(只服务端)。按 client/server 硬切会切出一份要被复制的原语。
  - **搬走一个符号前先数它的使用者。** `toPerpView` 在 core 之外零使用者(只有 `account-view` 调),`downsampleSeries`/`toDailySeries` 各只有一个 —— 这种不需要共用层,直接并进那个唯一的使用者。

- **纯逻辑不能内联进一个会拉起 `cloudflare:workers` 的模块** —— 它的 node 环境单测会跟着被拖进 worker 依赖链(见 `vitest.config.ts` 的 logic/dom 分项)。这种就在使用者**旁边**单开一个 `.ts`(如 `components/manual-tokens.ts`、`components/incomplete-specs.ts`),而不是塞进使用者文件里。

- **一个包只要导出 `Context.GenericTag`,它的主入口就是服务端入口** —— 不要在同一个入口再转发客户端要的契约。客户端为了拿契约 import 它,`effect` 就跟进 bundle(+75 KB gzip),而且这事只在有人第一次那么写的时候才发生,平时看不出来。`@folio/oracle-basic` 用 `./ports` 子入口分开;`@folio/oracle` 整包只有服务端碰,所以它干脆不转发 basic。

## Effect

迁移进行中(ADR 0035:`sync` → `connectors` → `shared` → `clients` → `oracle` → `db`,前端明确不碰)。
下面是 `@folio/sync`、`packages/clients/*`、`@folio/oracle`、`@folio/db` 四站踩出来的,
**每条都对应一次返工**。

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
- **「一个 config 对象装七个工厂回调」就是没写完的 Layer。** oracle 那一站删掉的 `createOracleFor({
  createTokenStore(userId), createUpstream(), …, overrides, now })` 是这个模式的极端形态:七个回调 +
  一份手写的惰性(getter + `??=`)+ 一个只有测试传的 `now`。换成 Layer 之后惰性归 Layer memoisation,
  而当初担心的构造成本经实测是不存在的(`packages/db/src/connect.ts` 自己写着「drizzle(env.DB) 很轻」)。
  **判据同上:生产只传一个值的字段,不该是字段** —— `namer` / `overrides` 是 adapter 的知识,
  就该由 adapter 的 layer 给(`Namer`),不该经装配点转手。
- **服务的方法签名里不许出现自己的依赖。** 服务对外的 `R` 恒是 `never`:实现面(`R` 里带着
  client / HttpClient / store)在**建服务那一刻**把 context 抓住(`Effect.context` + `Effect.provide`),
  或者干脆把已解析好的服务对象当参数传给内部函数。漏出去一次,调用方的 `R` 就长出一条
  `Outbound`,再往上传染到每个 server fn。
- **契约包里的 Tag 单开一个入口。** `Context.GenericTag(...)` 是**运行时值**,而契约包的主入口
  常被客户端组件 value-import(`@folio/oracle-basic` 的 `SUPPORTED_CURRENCIES` / `valuate` /
  `tokenTicket`)。并进主入口就等于把 `effect` 挂在前端 bundle 的可达图上(+75 KB gzip),
  摇不摇得掉全看打包器 —— 所以 Tag 走 `@folio/oracle-basic/ports`(只有服务端会碰)。
  同理:客户端组件别从 entry 包 value-import 常量(`TOP_TOKENS_LIMIT` 那一处已改成从 basic 取)。
- **包一个 promise 库时,桥只留一处。** drizzle / fetch 这类库的边界必须有 `Effect.promise`,
  问题只是它出现几次。`@folio/db` 那一站的答案是一个 `DbClient` 服务(`query(build)` /
  `batch(build)`),四个 store 里一个 `Effect.promise` 都没有 —— 撒在几十个方法体里的话,
  将来想加一个 span、一行慢查询日志、或者换个客户端就要改几十处。
  (它以前叫 `Database`;那个名字让给了包对外的聚合门面,桥本身**仍然不出包**。)
  **收 builder 而不是收造好的语句**:语句得拿库的句柄才造得出来,而让调用方先把句柄掏出来
  就等于又能绕过这一层(原则 #6 在包内的形状)。
- **迁一个包之前先问「谁在消费」。** 有 Effect 消费者的那一半迁了会**删东西**(oracle 那一站
  删掉了一份推导出来的镜像类型 + 70 行适配层);没有消费者的那一半迁了只会把 `await` 改成
  `yield*`,那就是 epic 里说的「包层壳」,而判据写在那儿:**收益小的包可以永远不迁**。
  两种形状暂时共存不是罪 —— 底下是同一个连接,只有出口形状不同。
- **服务的形状从实现推导,不在旁边再手写一份 `interface`**(#501)。手写那份会赢下每一次
  cmd+click —— 读的人落在一排签名上,而判据、边界、为什么这么写全在实现里;两份还迟早对不上。
  按**这个服务要不要参数**分两种写法:
  - **无参** → `class FxService extends Effect.Service<FxService>()("oracle/FxService", { effect: make }) {}`。
    类型、Tag、layer(`.Default`)一次拿全,并排的那个 `xxxServiceLayer` 随之退场。
    **测试的假实现走它自己的构造器**(`new FxService({ … })`):实例带 `_tag`,裸对象编译期就被拦,
    而且假的与真的是同一条构造路。
  - **要 userId 的服务也不带参数**(ADR 0044):`make` 里 `const userId = yield* CurrentUser` 读一次,
    于是 `.Default` 仍是一个普通 layer,`R` 里多一个 `CurrentUser`。装配点一次请求 provide 一次
    (`perRequestLayer(userId)`),不再每个领域一个 `xxxStoreLayer(userId)` 工厂。
    **在建服务那一刻读,不在每次调用时读** —— 后者会把 `CurrentUser` 漏进每个方法的 `R`,
    也就等于允许「同一个实例在一次请求里对不同用户各跑一遍」,那才是真的动了 ADR 0037。
    `effect` 字段**也**能收函数(`.Default(userId)`),但本仓不用它:userId 有更该待的地方。
  两种都**逐方法显式标注返回类型** —— 契约精度不靠推断,推断只用来省掉那份复述。
  **一契约多实现的端口不在此列**:那边 interface 必须独立存在(见下一条),没有模板可省。
- **端口的 Tag 与 interface 同名**(`Context.GenericTag`,`@effect/platform` 的 `FileSystem` /
  `HttpClient` 同款):契约名本身就是全仓的词表,不值得为了挂一个 `static layer` 把它们改名成 `*Api`。
  `packages/clients/*` 那边的 `class XxxClient extends Context.Tag(...)<XxxClient, XxxClientApi>()`
  是「一个包一个 SDK 出口」的形状,两者各自成立。
- **服务名:单数 + 角色后缀**,不用复数集合名(`Tokens` / `FxRates` 读起来像数据类型)。
  后缀按这个优先级挑:**精确角色后缀(`Store` / `Upstream` / `Source` / `Client`)> 裸能力名
  (`Clock` / `Logger` 那款)> `Service`**。
  - **`Resolver` 不要用** —— Effect 里 `RequestResolver` 是核心概念(`Effect.request` 的批量/
    去重机制),普通服务叫 `XxxResolver` 会让读的人先猜错一轮。参考层的 `PlatformResolver`
    因此改名 `PlatformService`。
  - `Service` 是**兜底档**,只在前两档都不成立时用:动词面太杂(读+写+暖+搜)的领域门面没有
    不撒谎的精确后缀,而裸名(`Token` / `Platform`)会撞仓里已有的数据词。参考层的三个门面
    (`TokenService` / `FxService` / `PlatformService`)就是这一档;端口层占的是第一档,不动。

### 错误

- **错误类型按「消费者要区分什么」划分,不按上游/模块划分。** 七个上游共用四类 tagged error
  (凭据 / 限流 / 够不到 / 读不动),因为消费者(适配层)对七家是同一个,它要做的判断永远是这四个。
  各定一套的代价是 7 套同构错误类 + 7 份几乎一样的下游映射。
  上游之间的真实差别是**怎么归类**,不是**分成哪几类** —— 那部分一家一行,写在那家自己的包里。
- **判 `_tag`,不判 `instanceof`。** 后者额外要求两个类来自同一个模块实例 —— 那是包管理器的事,
  不该是正确性的前提。
- **`E` 里只放有人会处理的东西,其余走 defect。** 参考层的 store 端口(D1)错误通道是 `never`:
  今天没有一个调用点 catch 它,行为是整个请求 500,做成 typed error 只会迫使每个调用点写一遍
  `catchAll` 再扔回去。出网那一侧相反 —— 它**有人处理**(降级到本地旧值),所以 `E` 是那四类
  `UpstreamError`。
- **降级要按类型接,而且要留痕。** `try { … } catch { /* 降级 */ }` 有两个毛病:连自己的 bug
  一起吞(parse 写错了抛 TypeError,和一次 429 长得一样),以及一行痕迹都不留(上游整晚限流,
  日志里什么都没有)。改成 `catchAll`(只接 typed 的上游错误)+ 一条 `logWarning`。
  **降级到 `Option.none()` 而不是空集合**,当「上游说它没有」与「上游挂了」的后续动作不同时:
  platform 预热那处给空表会把「链不存在」写成否定缓存记一天。
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
  (`packages/clients/*` 的 12 个测试文件里一次都没走过)。
  **更省事的办法是别留第二条路**:oracle 那一站的 `make*` 压根不导出,共用 harness 把假端口
  provide 成 layer,于是每个用例走的都是生产那条 Tag → Layer 的路(见
  `packages/oracle/entry/tests/fakes.ts`)。
- **`@effect/vitest` 现在装不了**(2026-08):稳定版 `0.30.0` peer 是 `vitest ^3.2.0`(本仓 4.x),
  支持 vitest 4 的 `4.0.0-beta.x` 要求 `effect ^4.0.0-beta`(本仓 3.22)。硬装能跑(验过),
  但要写一条「忽略 peer 冲突」并一直挂着。**别再重新评估,除非 Effect 4 稳定了。**

## File placement

页面相关的放一块,真通用的底座才进公共目录。别人要用业务件,来这里 import,不要因为「别处也用」就升格。这个区块没用到的,别塞进来。

相关的收进文件夹,入口只导出这一块,别当中转站。骨架、空态、失败态写在用到的文件里。只包一层、自己没做决定的文件删掉。独立文件要有自己的逻辑,并且不止一处在用。

动画和业务分开;为了好读可以在同文件抽小组件,别为此新建文件。不同的事不要揉进一个 hook,能拆就拆,可以放同一个文件,组件只负责拼起来。客户端会用的跟页面走,只有服务端用的进服务端目录(`lib` 三层见 [Implementation shape](#implementation-shape))。

画不出来就别画;后到的内容先占位,别把布局顶开。点不到的交互直接删。同一类东西各处长得要一样。

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
