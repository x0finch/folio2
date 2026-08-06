# connectors 按「客户端 / 适配层」拆分,`providers/*` 那一层取消

`packages/connectors/providers/*` 下每个包都把两件不相干的事装在一起:**怎么跟上游说话**(签名、限频、退避、多 host、DTO 形状)和**怎么把上游的话翻译成 folio 的 Balance**(`parse*` 纯函数、`BalanceProvider` 实现、`accountCreds` 声明)。binance 那个包 `src/index.ts` 一个文件 781 行,HMAC 签名、两个限频器、四个 client 工厂、五个 `parse*` 函数、base URL 覆盖全挤在里面。

这不是疏忽 —— 仓里**已经有两个包走的是拆开的形状**,只是没有推广:

- `blockbook`:请求层在 `packages/clients/blockbook`(`@folio/blockbook-client`),`providers/blockbook` 只剩 304 行纯适配,包内零 `fetch`。
- `manual`:无外部 API,适配直接写在 `entry/src/connectors/manual.ts`,`providers/manual/` 是个**只剩 `node_modules` 的空目录**。

**决定:取消 `packages/connectors/providers/*` 这一层。请求层各自升为 `packages/clients/<upstream>` 独立包,适配层直接落 `@folio/connectors-entry`。** 也就是把 blockbook 已经证明可行的形状推广到其余 7 个上游。

## 拆分后的结构

```
packages/clients/
  bitcoin-derive/     已有
  blockbook/          已有 —— 本 ADR 的范本
  coingecko/          已有 —— SDK 式出口的范本
  binance/ okx/ bybit/ zerion/ rabby/ coinstats/ hyperliquid/   ← 新建

packages/connectors/
  basic/              契约基座,不动
  entry/              manifest + 适配层(parse* / BalanceProvider / accountCreds)
  providers/          ← 整层删除
```

client 出口照 `@folio/coingecko-client` 的形状:`createXxxClient(config)` 返回带类型方法的对象,传输层内部化,对外只有方法 + 错误类型 + DTO 类型。

## 三个边界决定

**适配层落 `entry`,`basic` 保持独立。** 契约基座(`BalanceProvider` 接口、`Balance` 判别联合、`creds` / `crypto`)被所有人依赖,与实现分开是对的,不并进来。`entry/src/connectors/<id>.ts` 从 20 行 manifest 长成 400 行以上的,拆成目录:`connectors/<id>/{manifest,parse,provider}.ts`。

**base URL 覆盖归适配层,client 只吃不透明参数。** binance 的 `BASE_OVERRIDE`(#264,远程出口 IP 被上游按地区拒时注入代理 base)现在横跨两边:env key 声明是适配层的事,拿着 base 建 client 是请求层的事。拆分后 client 只接受 `{ baseUrl }` 当**不透明整串**,适配层负责从 `ctx.creds` 挑出来传进去 —— client 完全不知道有代理这回事。这比现在更干净,不是妥协。

**本 ADR 推翻核心原则 #3 中「每个 provider 一个包」那半。** 原文:*each provider is an independent package (`@folio/provider-*`, own package.json), interdependency-free*。改后 provider 不再是包边界;适配层之间的复用变成**同包内的模块复用**而非跨包依赖(`coinstats` 一份适配服务 solana / sui / cosmos 三个 manifest,`zerion` 与 `rabby` 同属 `evm` 一个 manifest)。原则 #3 的其余部分(provider 统一实现同一接口、UI 归 `@folio/ui`)不变。CLAUDE.md 同步改。

## 搬家与 Effect 化合并进行,顺序是 connectors → clients → shared

**搬家不单独成批。** client 包是新建的,「先写 Promise 出口、后改 Effect」等于同一批文件搬两次,而第二次的 diff 还和第一次大面积重叠。新建即写成 Effect。

client 方法的出口**必须是 `Effect` 而不是 `Promise`**:内部用 Effect、出口 `runPromise` 转 Promise 等于白用 —— 外层的超时和中断管不到里面的重试,正是 `@folio/sync` 迁移时踩过的坑(`Effect.promise(() => runPromise(inner))` 切断 context,`TestClock` 驱动不了内层重试)。

### 三步,以及为什么是这个顺序

**1. `connectors`(只改接口,不碰 `ProviderError`)** —— `basic` 里新定一个 Effect 原生错误类型(`ConnectorError`,`Data.TaggedError`),`BalanceProvider` 的 `fetchBalances` / `validateAccount` / `validateCreds?` 三个签名改成返回 `Effect`。签名一改 9 个 provider 实现全得跟着动,所以各加**一行** `Effect.tryPromise({ try: 原实现, catch: fromProviderError })` 顶着,内部一个字不动。`packages/sync/src/errors.ts` 那座临时桥(`toFetchBalancesError`)连同 `FetchBalancesError` **这一步就删掉** —— sync 直接 `yield*` provider 的 Effect。

**`ProviderError` 本身不改造。** 它保持普通 `Error` 子类原样,随 9 个 provider 包被搬空而自然零引用,在步骤 3 跟着删。理由见下方 Considered Options —— 简言之:那 196 处引用大半在马上要被搬走的包里。

**2. `clients`(逐上游纵切)** —— 一个上游一个 PR:建 `packages/clients/<x>`(Effect 原生,用 `Schedule` / `Effect.retry` / `Effect.timeout` 而非 `shared` 的手搓版)+ 适配层搬进 `entry` + 删掉步骤 1 那行 `Effect.tryPromise`,适配层从此直接吐 `ConnectorError`。7 个 PR,binance(781 行)单独一个。中间态的桥是一行,且就在要被替换的那个函数里,不会漏。

**3. `shared`(收尾,主要是删)** —— 到这一步 `retry.ts` / `http.ts` 的调用方大概只剩加账户探活一类零散处。这时才决定留什么。

**顺序不是「从依赖底层往上」而是「从契约往实现」,是有意的。** 反过来先改 `shared` 会陷入**凭猜设计接口**:那时仓里还没有任何 Effect 消费者,「Effect 版的 http / retry 该长什么样」只能靠推测,7 个 client 接上时大概率要再改一遍。而 7 个 client 各自用 Effect 原语写完之后,哪些能力真的重复、哪些本来就该各自持有,是**看出来的而不是猜出来的**。先具体后抽象。

同一个原因让 `shared` 那步变成**删代码而非迁代码**:client 直接用 `Schedule`,`shared/withRetry` 自然就没人调了 —— 正是 ADR 0035 说的「替代而非迁移」。先改 `shared` 则是「改一遍 shared,再让 7 个 client 跟着改」,同一批代码动两次。

**一个未验证的边界**:`shared/ratelimit.ts` 有 `SlotStore` 抽象,为跨 isolate 共享额度而设(CF Workers 上多个 isolate 花同一份出口 IP 配额)。Effect 的限频原语是进程内的,**能否替换尚未查证** —— 退避重试确定能换,限频可能要保留手搓。这个边界会在步骤 2 写第一个带限频的 client(binance,两个限频器)时自然暴露,不必提前定。

这条顺序**修正 ADR 0035**,那里定的是 `sync` → `connectors` → `shared` → `clients`;`clients` 与 `shared` 对调。

## Considered Options

- **connectors 合成单包**(`basic` 也并进来)—— 否。契约基座被所有人依赖,和实现同包会让「谁依赖契约、谁依赖实现」分不清,也让 `basic` 的改动波及面失去边界。
- **保持现状,只把请求层抽成 client** —— 即 `providers/*` 留着当纯适配包(blockbook 现在的样子)。否掉的理由是**那一层不再承载任何东西**:一个 package.json + tsconfig + vitest.config 换来的只是「适配代码在自己的包里」,而适配代码没有独立发布、独立版本、独立依赖的需求,`entry` 是它唯一的消费者。9 个包的配置维护成本换零收益。
- **先纯搬家(保持 Promise 出口)、Effect 化留作独立一批** —— 否。这样 diff 最好读(第一批只有文件移动),但同一批文件要搬两次,第二次的 diff 与第一次大面积重叠,总改动量反而更大。按上游纵切已经把单个 PR 的量压到可读范围,不需要再靠「只搬不改」来降复杂度。
- **Effect 化从 `@folio/shared` 起(从依赖底层往上)** —— 否,理由见上节:那时没有任何 Effect 消费者,接口只能靠猜,且会让 `shared` 从「删代码」退回「改代码」。
- **先把 `ProviderError` 改成 `Data.TaggedError`,当作步骤 1 的一部分** —— 否,而且否掉的理由和上面两条是同一个:那 196 处引用大半落在 9 个 provider 包内,**这些包在步骤 2 会被整个搬走**,等于改一遍再搬一遍。收益也小:sync 侧的重试只用到 `.retryable` 字段,`catchTag` 的穷尽检查在只有一种 provider 错误的地方没什么可穷尽的。正确做法是每片搬迁时在那个上游的适配层里就地转换,`ProviderError` 随最后一个 provider 包消失。**接口签名是唯一的例外** —— 它在 `basic` 里、不会被搬走,而它一天不返回 `Effect`,第一片建的 client 就得在适配层 `runPromise` 转回 Promise。

## Consequences

- **包数:9 个 provider 包 → 7 个新 client 包**(blockbook 已有,manual 无需);适配层不再占包。workspace glob 去掉 `packages/connectors/providers/*`。
- **`entry` 变重。** 它从「20 行 manifest × 10」变成同时装 manifest 与全部适配逻辑,并接手 provider 包原有的 `@folio/oracle-ref` / `@folio/shared` 依赖。这是有意的:适配层的唯一消费者就是它。
- **测试跟着代码走。** `parse*` 的 golden test 与 fixtures 随适配层进 `entry/tests/`(binance 一家就是 6 个测试 + 12 个 fixture);限频 / 签名 / HTTP 归类的测试随请求层进各 client 包。
- **knip 是这批 PR 的主要护栏。** 每片都在移动导出面,任何「搬过去没人引」的东西都会被它抓出来 —— 正好用来确认没搬漏也没搬多余。
- **golden test 是行为不变的凭证。** 搬家与 Effect 化同批进行,唯一能证明「翻译逻辑没被改动」的是 `parse*` 那批 golden test 连着 fixtures 原样通过。所以每片的顺序是:先把 fixtures + golden test 搬到新位置跑绿,再动请求层。
- **搬家影响面已确认很小**:包外引用只有 `entry/package.json` 的 8 条 workspace 依赖和 `entry/src/connectors/*.ts` 的 import,`apps/web` 零引用。

关联:#362(Effect 迁移 epic,本 ADR 是其 connectors 那一站的前置)、ADR 0035(迁移顺序在本 ADR 修正)、`packages/clients/blockbook`(形状范本)、`packages/clients/coingecko`(出口范本)、`packages/sync/src/errors.ts`(`toFetchBalancesError`,Effect 化那批拆掉)。
