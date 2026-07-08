# Connector manifest —— balances 子系统重写(@folio/connectors)

Status: accepted (planned)

把余额子系统围绕 **Connector** 概念重写:一个 connector = 我们支持的一类账户(evm / bitcoin / binance / okx / hyperliquid / solana / sui / cosmos / manual,共 9 个)。**不再有独立的 `accountType` 概念** —— connector 即身份。每个 connector 一份**自包含 manifest**,把"这类账户怎么建 + 想要什么余额数据 + 有哪些 provider"绑在一起。取代现有 `packages/balances` 子树(`basic`/`entry`/`providers/*` 共 9 个包)与其 accountType/BalanceProvider 契约。

> **命名:Connector ≠ Platform。** 词汇表里的 **Platform**(持仓所在的**链∪场馆**展示维度,key 如 `eip155:1`/`exchange:binance`,归 `@folio/platforms` 包)是资深、用户可见的概念,保留不动。**Connector** 是本次新增的**可插拔账户类型单元**(归 `@folio/connectors` 包),粒度不同:一个 connector(如 `evm`)的持仓会散落到多个 Platform(`eip155:1`/`eip155:8453`…)。二者正交。(曾把 `@folio/platforms` 临时改名让位,已回退——Connector 用自己的包名,旧包无需让位。)

> 本 ADR 取代同号的前一版(已 retract,git 9315647)。前一版是"accountType 数据约束层 + 全局 provider 注册表"两层设计,经多轮增量打补丁后 accountType 两处声明、账户定义与 provider 定义跨包割裂——推倒重来为一份连贯设计。经一轮 grill-with-docs 逐分叉压测后定案(下方决策)。

## 决策(grilling 锁定)

1. **概念 = Connector**,**三层子包**(镜像旧 balances 机制,面向远期第三方 provider 独立分发):`@folio/connectors-basic`(契约)+ `@folio/connectors-provider-*`(各数据源实现,一包一 provider)+ `@folio/connectors`(entry:registry + connector manifest,只组合)。DAG:basic ← provider-\* ← entry。旧"链∪场馆元数据"包 `@folio/platforms`(词汇表的 Platform)不动。
2. **connectorId = 干净短名**(`evm`/`binance`/`bitcoin`/`solana`/`sui`/`cosmos`/`okx`/`hyperliquid`/`manual`),D1 `account.type` 列做**值迁移**(`onchain_evm`→`evm`…)。
3. **category 撤销**——加账户弹窗平铺,删 `TYPE_GROUPS`/`AccountCategory`/`cat_*`(实证:category 全仓仅 add-account 分节标题一处用到,且本就是显式表非字符串切割)。
4. **Balance = 5-kind 扁平判别**(见下);`manual→spot`、`bitcoin→utxo`。
5. **defineConnector 仅为类型推断**(schema 事实源 `B=z.infer<schema>`,禁 `z.ZodType<B>`)。
6. **creds 双泛型**(账户级 AC + provider 级 PC)。
7. **EVM = 一个 connector**(仅地址、跨链靠 `tokenKey`);`account.network` 列保留、与 connectorId 正交(喂 Platform key 解析)。
8. **registry = `connectorId → manifest`;选 providers[] 第一个**;运行时"选/配 provider"机制延后。

## 契约

```ts
// creds 字段 = 现有 ProviderInput(Standard Schema 校验器,库无关 —— zod v4 官方 library-authors 指南
// 正推荐库无关校验走 Standard Schema)。CredsOf 从 const 字面量 creds 推出精确形状。
interface CredField<T = unknown> {
  key: string; type: "public" | "semi" | "secret";
  validator: StandardSchemaV1<unknown, T>;
  label: string; desc?: string;
}
type CredsOf<C extends readonly CredField[]> =
  { [E in C[number] as E["key"]]: E extends CredField<infer T> ? T : never };

// provider 拿到的上下文:两组 creds 都类型化(决策 #6)——账户级 AC 从 connector.account.creds 下来,
// provider 级 PC 是本 provider 自身配置(scope-A 下恒空)。
interface FetchContext<AC = Record<string, unknown>, PC = Record<string, unknown>> {
  account: { id: string; label: string; connectorId: string; creds: AC };
  creds: PC;
}

interface BalanceProvider<
  B extends Balance,
  AC extends readonly CredField[] = readonly CredField[],  // 账户 creds(来自 connector.account.creds)
  PC extends readonly CredField[] = readonly CredField[],  // provider 自身 creds(空 = 开箱即用)
> {
  id: string; label: string;
  creds: PC;
  defaultEnabled?: boolean;
  fetchBalances(ctx: FetchContext<CredsOf<AC>, CredsOf<PC>>): Promise<B[]>;   // 窄化到该 connector 的 B
  validateAccount(ctx: FetchContext<CredsOf<AC>, CredsOf<PC>>): Promise<boolean>;
  validateCreds?(creds: CredsOf<PC>): Promise<boolean>;
}

// connector manifest:schema 是事实源,B = z.infer<schema> —— 绝不写 z.ZodType<B> 注解(zod v4 footgun,
// 见 Considered Options)。defineConnector 仅为【类型推断】存在(const 泛型穿 account.creds + schema),
// 把 AC / B 灌进内联的各 provider;不是退化的 identity(区别于已砍的旧 defineProvider)。
function defineConnector<S extends z.core.$ZodType<Balance>, const AC extends readonly CredField[]>(
  m: {
    id: string; label: string; logo: string;      // connectorId(取代 accountType)+ 展示
    account: { creds: AC };                        // 建账户用户要填什么(地址 / key+secret / manual 字段)
    balance: { schema: S; providers: BalanceProvider<z.infer<S>, AC>[] };  // providers 里 PC 各自站点推断、数组内擦除
    // 将来 transaction 平行加 transaction:{schema,providers},不引泛型 facet 抽象
  },
): ConnectorManifest;
```

**Balance 类型完备 —— 5-kind(决策 #4,接受破坏)**:zod 判别联合,判别式 `kind`,`meta` 随 `kind` 精确。

> **`kind` 的定义(governing)= "一套独有的 meta + 渲染契约"的扁平判别**——不是资产、不是链、不是来源。凡不满足"有自己的 meta 且渲染不同于他者"的都不配当 kind。

```
spot          // 同质代币持仓(钱包 token / CEX 现货 / 手录持仓)。无额外 meta,基础行
defi          // 协议内仓位。meta: protocol / positionType;按协议分组;LP 整池带值、底层币 value:0
perp_equity   // 永续账户权益行(净值载体)。meta: withdrawable / totalMarginUsed / totalNtlPos
perp_position // 单永续仓位。meta: side / entryPx / liqPx / leverage / uPnL;value:0
utxo          // UTXO 型自托管持仓(BTC 及将来 UTXO 链)。meta: pendingSats / 派生地址表 / 收款指引
```

现状是 4-kind(`spot/defi/perp/manual`,perp 靠 `meta.role`、bitcoin 骑 `spot`),本次改判:perp 拆两 kind;bitcoin 以**模型名 `utxo`** 独立(非资产名);**`manual` 撤销**——它渲染/ meta 与 `spot` 全同(读端一路 `spot || manual`、无专属 meta、重估按 `accountType` 非 `kind`),是"来源"不是"契约",故 manual 账户吐 `kind:"spot"`,"手录"这件事留在账户层(`accountType==="manual"`,代码本就如此)。

每 connector `balance.schema` = 它会吐的 kind 子集判别联合;`B = z.infer<typeof schema>`(schema 是事实源,不反向注解)。写端(provider 返回被 schema 窄化 → 给 perp connector 写 `kind:"spot"` 编译即挂)、运行时(可选 `schema.parse` 校验 provider 输出)、读端(聚合/展示 `switch(kind)` 穷尽、meta 自动窄化、消灭 `meta as X` cast)三处一致。

## Considered Options

1. **两层:accountType 数据约束层 + 全局 provider 注册表**(前一版 0009,已弃)—— accountType 在 union 与 specs 双声明、易漂移;账户定义与 provider 定义跨包割裂;增量打补丁失控。
2. **Connector 自包含 manifest(选中)** —— 一份 manifest 绑定 account.creds + balance.schema + providers;无独立 accountType;account 定义与 provider 定义/实现同处一包,好用、好删旧。
3. **松散 `meta: Record<string,unknown>`** —— 现状,需 `as` cast、非穷尽;被"类型完备"否决(改判别联合)。
4. **每 connector 自定义完整 Balance 类型(无共享基座)** —— 聚合层要跨 connector 统一相加,必须共享基座;否决,改"共享基座 + 每 connector kind/meta 判别子集"。
5. **`schema: z.ZodType<B>` 反向注解 B**(初版契约)—— 被 grill-with-docs 否决:zod v4 官方 [library-authors 指南](https://zod.dev/library-authors) 明确 "This approach is incorrect, and limits TypeScript's ability to properly infer the argument",schema 会塌成 `$ZodType`、泛型退化 `any`(回归 [zod#4492](https://github.com/colinhacks/zod/issues/4492))。改为 schema 是事实源、`B = z.infer<schema>`,泛型约束 `S extends z.core.$ZodType`,推断经 `defineConnector`(决策 #5)。
6. **命名 Platform vs Connector** —— 词汇表已有 `Platform`(链∪场馆展示维度),若新概念也叫 Platform 则两义打架、且粒度不同(1 connector 对多 Platform)。新概念定名 **Connector**,资深的 Platform 及 `@folio/platforms` 包保留(此前为让名把它临时改 `platform-old` 的机械提交已 force-revert)。
7. **kind 分类法**(grilling 逐条压测后定案)—— 定义锁死为"一套独有 meta+渲染契约的扁平判别"。据此:①保留 4-kind + 不动快照(经济形状哲学,保兼容)被否;②中途的 6-kind(含 `bitcoin`/`manual`)也被否——`bitcoin` 是资产、`manual` 是来源,都不是"契约"(代码实证:manual 读端全程与 spot 同分支、无 meta、重估按 accountType)。**终案 5-kind**:`spot/defi/perp_equity/perp_position/utxo`。接受破坏历史快照(见 Consequences)。
8. **connectorId 取值:复用现有 `account.type` 值 vs 洗成干净短名** —— 选后者(`onchain_evm`→`evm`…),换来 id 简洁 + category 从 id 字符串编码里解耦;代价是 `account.type` 列一次性值迁移(见 Consequences)。

## Consequences

- **新三层子树 `packages/connectors/{basic,providers/*,entry}`**:`basic`(`@folio/connectors-basic`:balance/creds/connector/errors 契约)、`providers/<源>`(`@folio/connectors-provider-<源>`:一包一 provider 实现,内含该 connector 的 `account.creds` 声明与其天然消费者同处)、`entry`(`@folio/connectors`:registry + `connectors/*.ts` manifest,只组合引用 provider + 再导出契约给 app)。删除 `packages/balances/*` 9 包及所有 `@folio/balances*` 引用。**`@folio/platforms`(Platform 元数据包)不动** —— 它是 chain∪venue 的 name+logo 层,与 Connector 正交,仍被 logo 代理 #20 / overview 装饰用。
- **CLAUDE.md 原则 #3 保留"每个 provider 独立包"的精神**,措辞更新:provider 包命名 `@folio/provider-*` → `@folio/connectors-provider-*`;connector(entry manifest)只组合、不含实现。方案 A(共享数据源)相应为"一个 provider 包(如 coinstats)被多个 connector manifest import"(不再是"出现在多个文件里")。
- **creds 边界不变(原则 #5 红线)**:`@folio/connectors` 只做 provider 面向的活(`validateAccount`/`fetchBalances`/`validateCreds`),**永不碰 `SECRETS_KEY`**;加解密/脱敏(seal/open/safeView)仍归 app `lib/creds.ts`,改由读 `connector.account.creds` 规格驱动(取代旧 `credentialSpecs`)。
- **两 creds / 两校验,两组都类型化(决策 #6)**:`account.creds`(账户级)与 provider 的 `creds`(PC,provider 级)靠所属对象区分;`validateAccount` / `validateCreds`(非 `validateKey`)。creds 形状不再 loose,经 `CredsOf<const 字面量>` 穿进 `FetchContext<CredsOf<AC>, CredsOf<PC>>` —— provider 体内 `creds.apiKey` 有编译期类型。代价:泛型三轴(B + AC + PC),靠 `defineConnector`/`defineProvider` 的 `const` 推断承载。PC 无 per-account 存储;provider 声明它需要的 key(如 ZERION_API_KEY),app 分派桥按 `field.key === env 变量名`从 env 注入**默认值**,用户自配留后续 phase。
- **两处数据迁移**:①`account.type` 值一次性 UPDATE 映射(`onchain_evm`→`evm`…,决策 #2/#8);②`balance.kind` 语义 forward-only **不迁移**(决策 #4)——`kind`/`meta` 已落进快照(`orchestrator.ts` 写 `kind: b.kind`),改分类法(perp→perp_equity/perp_position、bitcoin→utxo、manual→spot)使旧快照行 per-balance 语义失配,故读端须对**遗留/未知 `kind` 容错降级(default 分支,不 throw)**;历史时间线图只用 `totalUsd`(单列,不受影响),当前持仓来自最新快照(下次同步即写新 kind)。
- **Balance 判别联合是最大 blast radius**:overview-model / aggregate / account-view / 各展示组件全线适配(收益:去 cast、穷尽 switch)。`manual→spot` 让读端现有三处 `spot || manual` 分支(`overview-model.ts:73`/`tokens.ts:24`/`aggregate.ts:84`)收敛成 `spot`。
- **范围(本次)= 模型 + provider 重写;current 取数/展示行为不变,但 Balance 分类法 + account.type 改版**:空配置 = 现状,全局 key 照旧走;历史快照 per-balance 分类被破坏(见上,接受)。运行时"选/配 provider/免重部署 + 类型管理 UI + 生命周期(关闭归档/切换)"作为**后续 phase**(旧 epic 目标不丢,分期做)。
- **迁移走竖切、并存期分派(to-issues 定案 B,推翻初版"不双跑")**:不再一次性大爆炸。先预制读端(5-kind + 遗留-kind 容错),再**逐 connector** 切到新包 —— sync 注入处按 `account.type`→connectorId **分派新/旧**,新旧短暂并存;收尾片才拆桥、删旧 9 包、跑 `account.type` 值迁移。好处:每 connector 端到端独立验收、小 PR、可回退。切片见 epic #29 的 #30–#37。
- **CONTEXT.md**:新增 `Connector` 词条,并与既有 `Platform` 显式区分(互列 `_Avoid_`)。
