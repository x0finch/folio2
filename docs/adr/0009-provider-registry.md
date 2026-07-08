# Provider 运行时注册与配置 —— `@folio/provider-registry`(manifest + 全局配置,非插件运行时)

Status: accepted (planned)

把"编译期按 `AccountType` 写死的 provider 注册表"(`@folio/balances/entry` 的硬 `import` 列表 + accountType 硬映射)换成一个独立包 **`@folio/provider-registry`**:provider 仍**编译进 app**,但**启不启用、用哪个数据源、拿什么配置**由**运行时全局配置**决定 —— 加一个数据源(如 Solana 经 QuickNode)只需在 UI 里启用 + 填配置,**免重部署**。近期范围只做 **balance** 一类 provider;这**不是**运行时/第三方插件系统(那是远期,见 [ADR 0008](0008-logo-proxy.md) 下游的另立决策)。

> **照抄业界、不自创抽象**:成熟做法(Terraform 插件协议、Grafana backend plugin、MCP capabilities 握手)= **provider 声明它支持什么(manifest)+ host 分发 + host 负责生命周期(缓存/凭据)+ 密钥出站注入**。本 ADR 只取其中近期用得上的部分,明确**拒绝**为不存在的驱动预建装置(见 Considered Options 4)。

## Considered Options

1. **就地改造 `@folio/balances/entry`**(不开新包)—— 最不过度设计,但把"注册表 + 全局配置"焊死在 balances 里,将来 oracle(token/platform/fx)这类**非 balance** provider 要复用同一套注册/配置时得再抽。鉴于"provider 统一"是既定长期目标,选独立包。
2. **独立包 `@folio/provider-registry`(选中)** —— balance-scoped,但 "manifest 声明 + 全局配置" 两个概念天生通用,将来 oracle 加入是**加法**(多一类 provider 注册进来),不是重构。
3. **完整插件运行时**(协议 major/minor 版本、brokered-fetch 密钥经纪、transport 抽象层)—— 这些只在**跨进程 / 不可信代码**才需要:协议版本因插件与 host 分开发布才有意义,近期插件跟 app 一起版本;brokered-fetch 只为不让不可信代码见密钥,第一方 in-process 可信、provider 直接拿 key 即可;transport 只有一种。**全部拒绝/推迟**,有驱动时各自加。唯一保留的"保险"是**纪律性的**:provider 输入不塞 live `env`/db handle(保持可序列化),零成本、非代码。
4. **数据源建模:一个 provider 内 `if(dataSource)` 分支(画法 B)** vs **一个 backend 一个小 provider(画法 A,选中)** —— 不同 backend(QuickNode / Helius / RPC)是**不同代码**(不同 API/解析),拆成独立小 provider 逻辑更简单、扩展是加法;不往老 provider 塞分支。
5. **默认 key 与自定义 key 拆成两个 provider** vs **一个 provider + 分层配置(选中)** —— 默认/自定义是**同一份代码打同一个 API、只换钥匙**,属配置差异非身份差异;拆两个 provider = 复制近乎相同的实现,违反 DRY。**例外**:若"默认"走的是**另一条真实不同的路径**(如经 folio 代理服务转发共享 key),那才是不同 backend、回到画法 A 拆分。

## Consequences

### 两层(数据约束层 / provider 层)+ 两次校验
- **层 1 · accountType 数据约束**(`@folio/provider-registry` `ACCOUNT_TYPE_SPECS`):每个账户类型声明**账户输入 schema**(地址/xpub/CEX per-account key/manual 字段)+ 产出的数据 facet(`balance`,将来 `transaction`)。是"这个类型的账户长什么样"的唯一事实源,**与用哪个 provider 无关**(换 provider,账户输入不变)。`credentialSpecs()` / 加账户表单 / 运行时 creds 校验都读这层。
- **层 2 · provider**(`BalanceProvider`):只管自己的**全局 config**(`manifest.configSchema`,如 Zerion key)+ 怎么取数。契约瘦身:去掉 `inputs`(账户输入归层 1);`validate` → `validateAccount`;新增可选 `validateConfig`。
- **两次输入 × 两次校验**:
  - **输入 4(enable,provider 全局 config/key)** → `validateConfig()` liveness(实例化后打 key-only 探活;Zerion 用 `/chains`,无此端点的 provider 不声明 → 退化到形状校验)。
  - **输入 5(add-account,账户 creds)** → 层 1 validator 形状校验 + `validateAccount()` liveness。

### 用户模型(两层构造,provider 级配置与账户级输入分离)
- **UI 主体 = 账户类型**:类型管理页列出所有支持的 `AccountType` + 状态;provider 是"启用该类型"流程里的**选择项**(如启用 EVM → 展示 zerion/debank… 选一个 + 配 key 或用默认),**没有独立的 provider 管理页**。
- **两层构造**(有 `makeCoinstats` 工厂先例):
  - 启用类型时:`instance = makeProvider(全局 settings)` —— **provider 实例化**(全局 key 从"每次调用经 `globalKeys` 传入"变为**实例化参数**);
  - 添加账户后:`instance.fetch(account)` —— **账户级输入属于 account**(观察地址 / 每账户交易所 creds,加账户时填),传给已实例化的 provider 执行。
- **关闭类型**:检查该类型下有无账户 → 有则提醒 → 确认关闭后该类型账户**停止同步并 archived**(`archivedAt` 现有字段)。
- **切换 provider(同类型)≠ 关+启**:直接换、账户保留、不 archive;下轮 sync 走新 provider(账户级输入属类型,天然兼容)。

### 契约与解析(照抄业界锚点,近期只取所需)
- **provider 声明 manifest** `{ id, accountType, dataSource, configSchema, defaultEnabled }`(configSchema 复用现有 `ProviderInput`/Standard Schema 自描述);registry 从 manifest **自动组装**(取代硬 `import` 列表)。
- **`defaultEnabled` 按 provider 各自声明**:开箱能跑的(免费额度/公共数据/无需 key)`true`;要付费 key 的、冷门交易所 `false`。**生效 = 启用状态(配置行覆盖 ?? manifest 默认)且配置解析链能给出必需的 key**。
- **registry 仍按 `accountType` 键**,解析成"**已启用且被选中**的那个 provider";每 type 至多一个生效,切换即原子替换。
- **provider 输入保持可序列化**(不含 live handle)—— 唯一为"将来可换跨进程 transport"留的无悔约束。**不建** transport 抽象层、**不引**协议版本、**不建** brokered-fetch(均推迟到不可信/跨进程驱动出现)。

### 配置与密钥(复用现有 creds 模型,不造新机制)
- **配置表 = 纯覆盖表**:只存"偏离默认"的记录(停用/启用覆盖、选中的 provider、自定义 settings);**空表 = 各 provider 按自己 manifest 声明的默认**。回滚 = 删行。
- **每条覆盖记录** `{ accountType 或 providerId, enabled?, selectedProvider?, settings? }`;`settings` 内 secret 字段**复用 `SECRETS_KEY` 逐字段 AES-GCM**(与每账户 creds 同一套,P6.6.1),明文/semi 不加密。`SECRETS_KEY` 仍是唯一的 CF Secret 根。
- **存储在 `@folio/db` 新增的全局独立导出 `createProviderConfigStore`**(**无 userId**,单用户全局;与 `createTokenStore`/`createPlatformStore` 同风格,不进 `createDb` 门面)。**安全影响**:provider secret 因此落进 D1(密文)—— D1 备份含加密 secret,只要 `SECRETS_KEY` 不同备份即安全,风险画像同现有交易所 key。
- **配置分层解析(每 provider,自上而下)**:`用户自定义(D1) → 默认 → 未配置`。用户自定义永远优先;都没有 → 该 provider 停用 + 明确提示。provider **不感知**用的是默认还是自定义,registry 配置层决定给它哪个 key。
- **默认值红线(承 P6 "secret 绝不进 git")**:公开/非密默认(如公共 RPC URL)可随代码发;**默认 key 若是真密钥,绝不提交 git** —— 由发布/部署时注入(CF secret / 构建注入),仓库里只有"默认 key 槽"、无明文。folio 是否随发行版塞共享 key 是产品/发行决定,不写死进源码;registry 只认解析链。
- **现有 CF-env 全局 key(`ZERION_API_KEY` 等)不强制迁**:配置解析**先查 D1,读不到回退到约定命名的 CF env**;想 UI 可改时再迁。

### 各包改动(provider 内核不重写)
- **`@folio/balances`**:provider 取数逻辑不动,改为经 manifest 注册。
- **`@folio/db`**:加 `createPluginConfigStore`(全局配置 + 迁移)。
- **`apps/web`**:加 `buildProviderRegistry(env)`(仿 `buildTokens`/`buildPlatforms`);sync 注入点从"硬取 provider"改为"经 registry 取已启用+已配置的 provider";加 provider 列表/配置 UI(启用 + 选数据源 + 默认/自定义 key 切换)。

### 分阶段(各自独立可合可回滚)
1. **`@folio/provider-registry` + manifest 注册 + registry 接线** —— 行为不变、用户无感(⚠️ 触及 >8 文件:7 provider + registry + app 注入点)。纯重构可 revert。
2. **全局配置 store + UI + 分层解析 + CF-env 回退** —— 交付"加数据源、配好即生效、免重部署"。回退:配置读 D1↔env 双读兜底。
3. **(可选)单一 accountType 挂第二个 backend provider** —— 证明"一类账户可选多数据源",不做全量多源 UX。

### 载重假设与推迟项
- **假设**:第一方 in-process 可信 → 近期 creds 可在进程内传;若要更早跑不可信/跨进程代码,则须补回 brokered-fetch + 协议版本 + transport,Phase 1 成本上升。当前判断:近期只跑自己的 provider,假设成立。
- **推迟(有驱动再做,均为"加法")**:oracle(token/platform/fx 折叠成 `resolve*` 操作)、transaction facet、不可信第三方代码 / Dynamic Workers/Sandbox transport、协议版本、brokered-fetch。
- **非领域概念** → CONTEXT.md 不加词条;这是基建。
