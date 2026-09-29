# 0054 — 服务图每个 isolate 建一次,用户在每次调用时给

日期:2026-09-22。状态:已接受。**部分取代 [ADR 0044](0044-user-id-from-current-user-not-layer-params.md)**(读 `CurrentUser` 的时机);[ADR 0037](0037-db-userid-moves-from-signature-to-layer.md) 的保证不变,[ADR 0045](0045-db-and-oracle-export-shape.md) §3 的「一次请求一个 `DbClient`」不变。

## 背景

免费计划一次请求 10ms CPU。生产 bundle 的 V8 profile 里,最便宜的一个 server fn(`getValuationSettings`,回两个布尔)在前两片优化之后还要 ~10.5ms,其中 **Effect 那一块 5–7ms 一动没动**:它不是业务,是**每请求把整张服务图建一遍再拆掉** —— `userLayer(userId)` → 十二个领域 store(各自 `yield* CurrentUser`)、`tracedStores` 包七十来个方法、参考层三个服务 + CoinGecko 那几格、`ConnectorRegistry`、日志层,每次 `Effect.provide` 都是一张 memo 表 + 一个 scope + 全部构造。仓里没有一处 `ManagedRuntime`。

之所以每请求建,是 ADR 0044 定的:store 在**建自己那一刻**读一次 userId、绑进闭包,于是一个服务实例就是一个用户的 —— 图只能按请求建。

## 决定

**服务图每个 isolate 建一次;每请求只给两个值:这是谁(`CurrentUser`)、那一个 D1 句柄(`DbClient`)。**

- **`@folio/db`**:每个领域写成纯函数 `(client, userId) => 方法表`;聚合门票(`database.ts` 的 `bindPerCall`,全包唯一一处)在**每个 op 跑的那一刻**从 context 取这两样、绑一次、调那个方法。方法签名不变(没有 user 参数),`R` 多出 `DbRequest = CurrentUser | DbClient`。`GlobalDatabase` 只取连接,`R` 里没有 `CurrentUser`。
- **app**:`runtime.ts` 里一个**惰性**的 `ManagedRuntime`(形状同 `getAuth()`,模块加载期什么都不跑),装着 `Database`、参考层(`Oracle` 三个域 + 刷全局映射表的门面 + `GlobalDatabase`)、`ConnectorRegistry`、日志转发器。每请求:`provideCurrentUser(userId)` + `provideDbClient(env)` → `runtime.runPromise`。span 树仍按请求装(只在 debug)。cron 的逐用户活走 `forUser`(同样两个值 + 那个运行时);`/api/sync` 的后台根 fiber 用 `userLayer`,它从已建好的运行时取服务,只新建那两个值。

## CODING.md 的两条反对,怎么答的

**「每次调用读会允许同一个实例对不同用户各跑一遍」(原 CODING.md:118)** —— 现在这就是日常(两个请求并发打同一个实例),担心本身是对的,答法换成**把给 user 的材料收走**:`CurrentUser` 的 Tag 不再出 `@folio/db`(`export type`,当值用编译不过),包外唯一的给法是 `provideCurrentUser`,而 app 源码里只许 `runtime.ts` 写它 —— `user-services-surface.test.ts` 按源码 grep(连 `"db/CurrentUser"` 这个键一起,防有人自造同键 Tag)。以前任何一处都能 `Layer.succeed(CurrentUser, 随便谁)`;现在 app 里没有这份材料。`R` 里的 `CurrentUser` 让「忘了给」仍是编译错误(0044 选 Tag 不选 Reference 的理由原样成立)。

**「跨请求活着的 fiber / timer 可能撞上 Workers 的『不能替另一个请求做 I/O』」(原 CODING.md:173)** —— 逐层查了**建的时候握着什么**,判据:握 fiber、timer、I/O 句柄的留在每请求那一侧,纯闭包的才进 isolate。

| 层 | 建的时候握着 | 去处 |
|---|---|---|
| 三张 db 门票 | 方法名表 + 闭包(领域函数是纯的) | isolate |
| `DbClient` | `drizzle(env.DB)` | **每请求**(红线) |
| CoinGecko client | 请求头对象 + requester 闭包;生产的 `isolated` 限频闸是 `Effect.sync` 里的闭包,游标本来就在模块级 | isolate |
| `FetchHttpClient` | 一个函数;每一发现取 `globalThis.fetch`、现建 `AbortController` | isolate |
| 参考层三个域 / 刷表门面 / `ConnectorRegistry` / 日志转发器 | 闭包(查过没有 `let` / `Ref` / `Cache` / fork) | isolate |

唯一会在建的时候 fork 后台 fiber 的是限频的 `memory` 档(官方 `RateLimiter`),生产不走。**没有一层需要留在每请求**,CoinGecko 也进了 isolate(它以前每请求建一次,profile 里约 1.7ms)。Effect 全局调度器、限频游标的模块级信号量在改之前就跨请求共用,本 ADR 没有新增这一类对象。

## 否决的路

- **每请求照旧建,只是把 layer 换成裸闭包绑定**(不用 `ManagedRuntime`):省掉 memo 表与 scope,但七十个方法的包装、参考层的构造仍每请求付一遍;而且「用户藏在实例里」这件事不变,答不了上面第一条。
- **`Context.Reference` 带默认值**:`R` 不增长,但忘了给就静默按默认用户查 —— 0044 已否。
- **每个方法里 `yield* CurrentUser`**:七十处各写一遍、领域函数顶上的辅助闭包全要改签名;收在 `bindPerCall` 一处,读 context 的地方全包只有一个。
- **模块级单例 `DbClient`**:0045 §3 的否决照旧。isolate 级的是纯的那几层,不是连接。

## 代价

- 碰 db 的方法 `R` 里多一个 `DbRequest`,一路进到参考层的方法与 app 的 handler 签名(`UserServices` 并进了它)。`R = never` 的端口(`@folio/sync` 四个能力、导入的 `ImportDeps`、导出的流)在建那一层时 `Effect.context<DbRequest>()` 抓一份再 provide。
- 每个 op 调用多一次 context 读 + 一次领域函数绑定(十来个闭包)。
- 服务实例不再与用户一一对应 —— 隔离全靠「op 跑的那一刻读到的是自己那份 context」,所以它必须有用例钉着(下面)。

## 验收

- **CPU**(构建产物 `wrangler dev` + CDP 采样 100µs,A = 改前 / B = 改后,两台同时起、6 轮交替 × 40 次,中位数,ms/请求;cookie 像浏览器一样续,所以会话读走 cookieCache 不落 D1):

  | 端点 | A 总 | B 总 | A → B 的 Effect 那块 |
  |---|---|---|---|
  | `getValuationSettings` | 11.1 | **6.5** | 5.6 → **1.2** |
  | `listTags` | 13.3 | 8.9 | 6.4 → 2.3 |
  | `listAccounts` | 13.9 | 9.5 | 6.4 → 2.4 |
  | `getSnapshots`(此刻) | 29.2 | 23.8 | 13.1 → 7.3 |
  | `GET /`(已登录) | 6.6 | 6.9 | 这条路上没有 Effect,不受影响。**壳化前的数**:ADR 0049 补记之后导航请求不进 Worker,这行只证明本片没碰文档路径 |

  `getSnapshots` 剩下的 Effect 是 handler 自己的活(十几条查询各一个 fiber 步 + 富化),不是装配;其中「每条 `db.query` 抓一次调用点」那 ~1ms 顺手去掉了(`client.ts` 改 `withSpan` + `captureStackTrace: false`)。本地的绝对值比生产高(Miniflare + 采样开销),看的是差。
- **隔离**:workers 池 `isolate-runtime.test.ts` —— 两个用户 20 发并发打 `listAccounts`、以及同一条 fiber 树里两个用户的 op 交错跑,各自只看得见自己的行;把 `bindPerCall` 改成「缓存第一次的 context」当场红两条。同一份门票在 N 次调用间是同一个引用(建了一次)。
- **一次请求一个 `DbClient`**:`one-db-client.test.ts` 改成数真构造(`env.DB` 被读几次),跨三张门票、四个领域一次请求 = 1,同一组合子跑两次 = 2。
- **在 `wrangler dev` 上跑通**:构建产物,两个用户(种子用户 + 现注册一个),五个 server fn 200 发并发交错 + 两个用户各一发 `POST /api/sync`(后台根 fiber),再触发一次 `cron=30 * * * *`:零个非 200,40 次 `listAccounts` 的响应体里没有一次出现另一个用户的 id;cron 逐用户扫完、日志里的 userId 各归各;没有「替另一个请求做 I/O」一类报错。
  日志里会有 `Disallowed operation called within global scope`,来自 `@effect/platform` 的 `HttpClient` 用 `FinalizationRegistry` 在 GC 时 `controller.abort()` 未读完的响应 —— **改前的构建同样出现**(同一处代码,同量级),与本 ADR 无关,另记一票。

## 补记:isolate 那张图不再经 `ManagedRuntime` / Layer 建(FOL-83 第二轮,2026-09-28)

**只改「怎么建」,不改「建什么、活多久」**:仍是每个 isolate 一份、惰性、从不 dispose;每请求仍只给 `CurrentUser` + `DbClient`;上面那张「建的时候握着什么」的清单一格没动。

**为什么**:第一轮把后台拆成一条消息一次调用之后,冷 isolate 上的调用里最大的一块是**建这张图本身**。`perf:cpu:jobs` 的函数级 profile(`perf:cpu:analyze`)里,每天那个 cron 本体 57ms 中约 45ms 花在 `runAtEdge → ManagedRuntime` 的构建里,业务一行还没跑;`--warm`(同一个 isolate 连着跑)只剩约 7ms。Node 上冷进程对照:`ManagedRuntime.make(Layer.mergeAll(两张 db 门票 + 日志))` 20ms,同一份东西手搭成 `Runtime.make` 4.5ms;`Layer.mergeAll` 三个 `Layer.succeed` 冷的时候就要 5ms、热的时候仍要 2ms。钱花在 Layer 的机器上(memo 表、scope、并行合并 fork 的 fiber),不在服务上 —— 服务本来就是纯闭包。

**怎么建**(`apps/web/src/lib/server/runtime.ts`):

- **`dbRuntime`**:`Runtime.make({ context: databaseTickets(), fiberRefs: withLogTapeLogger(默认), … })`。`databaseTickets()` 是 `@folio/db` 新出的一个函数:与 `Database.Default` / `GlobalDatabase.Default` **同一个构造函数**(`databaseOps` / `globalOps`),只是直接造成一份 `Context`。`withLogTapeLogger` 是日志层那两步(换默认 logger、门限 All)直接写进 `FiberRefs`,测试让每条日志用例在 layer 与 FiberRefs 两条路上各跑一遍。cron 开轮投消息、剪 note(`forUserDb`)、`withGlobalDb`、以及每个入口的边缘 `runAtEdge` 只用它 —— **不为一趟 cron 把参考层建起来**。
- **`isolateRuntime`**:在 `dbRuntime` 那份 context 上补参考层与 connector 门票。参考层的构造分散在各包的 layer 里、彼此依赖,仍经 Layer 建,但只建它自己:`Effect.runSync(Layer.buildWithScope(oracleServices(), scope))` 一次。`runSync` 是对「全同步」的断言 —— 哪天有人往参考层里加了一个要等 I/O 才建得出的 layer,这里当场 `AsyncFiberException`,而不是悄悄变慢。connector 门票同样直接造(`connectorRegistryContext()`,与 `.Default` 同一个 `makeRegistry`)。两个运行时里的 `Database` 是同一个对象。

**没变的**:`Database.Default` 等 layer 都还在(测试、`makeSyncServicesLayer`、参考层内部都用);`CurrentUser` 的给法、`user-services-surface.test.ts`、`isolate-runtime.test.ts`(两个用户交错、同一个引用建一次)原样通过。

**量到的**(本机,`perf:cpu:jobs --cron-only`,每次调用新起 worker):每天那个 cron 本体 53.7 → 17.7ms,每小时那个 38.5ms(原 72.2)。参考层那半的冷构建(本机约 20ms)挪到了「这个 isolate 里第一条要参考层的消息」上 —— 那是 cron 投出去的 `sync-account` / `prices` 等,它们本来就要它。

**否决的**:把整张图挪到模块顶层建(启动期 CPU 另算预算,不进这 10ms)。量上它最省,但它是把钱挪到启动预算里而不是省掉,且与「模块加载期什么都不跑」(CLAUDE.md、本 ADR 上文)正面冲突;参考层那半在顶层建还得确认没有一步碰到 Workers 在全局作用域里禁止的操作。留作以后的选项,不在本轮做。
