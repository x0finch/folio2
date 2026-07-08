# Platform manifest —— balances 子系统重写(@folio/platforms2)

Status: accepted (planned)

把余额子系统围绕 **Platform** 概念重写:一个 platform = 我们支持的一个东西(EVM / Bitcoin / Binance / OKX / Hyperliquid / Solana / Sui / Cosmos / Manual)。**不再有独立的 `accountType` 概念** —— platform 即身份。每个 platform 一份**自包含 manifest**,把"这类账户怎么建 + 想要什么余额数据 + 有哪些 provider"绑在一起。取代现有 `packages/balances` 子树(`basic`/`entry`/`providers/*` 共 9 个包)与其 accountType/BalanceProvider 契约。

> 本 ADR 取代同号的前一版(已 retract,git 9315647)。前一版是"accountType 数据约束层 + 全局 provider 注册表"两层设计,经多轮增量打补丁后 accountType 两处声明、账户定义与 provider 定义跨包割裂——推倒重来为一份连贯设计。

## 契约

```ts
interface PlatformManifest<B extends Balance = Balance> {
  id: string;                       // 平台标识(取代 accountType)
  label: string; logo: string;      // 展示
  account: { creds: CredField[] };  // 建账户用户要填什么(地址 / 交易所 key+secret / manual 字段)
  balance: {
    schema: z.ZodType<B>;           // 该平台的 balance 判别联合 schema(perp 与现货形状不同)
    providers: BalanceProvider<B>[];
  };
  // 将来 transaction 平行加 transaction:{schema,providers},不引泛型 facet 抽象
}
interface BalanceProvider<B extends Balance = Balance> {
  id: string; label: string;
  creds: CredField[];               // 实例化本 provider 要的 key(空 = 开箱即用)
  defaultEnabled?: boolean;
  fetchBalances(ctx: FetchContext): Promise<B[]>;         // 窄化到平台的 B
  validateAccount(ctx: FetchContext): Promise<boolean>;   // 账户 liveness
  validateCreds?(creds: CredValues): Promise<boolean>;    // provider 自身 creds liveness
}
interface FetchContext { account: { id; label; platformId; creds: CredValues }; creds: CredValues; }
```

**Balance 类型完备**:zod 判别联合,判别式 `kind`,`meta` 随 `kind` 精确(`spot`/`defi`/`perp_equity`/`perp_position`/`bitcoin`/`manual`)。每平台 `balance.schema` = 它会吐的 kind 子集判别联合;类型经 `z.infer` 推得。写端(provider 返回被平台 schema 窄化)、运行时(可选 `schema.parse` 校验输出)、读端(聚合/展示 `switch(kind)` 穷尽、meta 自动窄化、消灭 `meta as X` cast)三处一致。

## Considered Options

1. **两层:accountType 数据约束层 + 全局 provider 注册表**(前一版 0009,已弃)—— accountType 在 union 与 specs 双声明、易漂移;账户定义与 provider 定义跨包割裂;增量打补丁失控。
2. **Platform 自包含 manifest(选中)** —— 一份 manifest 绑定 account.creds + balance.schema + providers;无独立 accountType;account 定义与 provider 定义/实现同处一包,好用、好删旧。
3. **松散 `meta: Record<string,unknown>`** —— 现状,需 `as` cast、非穷尽;被"类型完备"否决(改判别联合)。
4. **每平台自定义完整 Balance 类型(无共享基座)** —— 聚合层要跨平台统一相加,必须共享基座;否决,改"共享基座 + 每平台 kind/meta 判别子集"。

## Consequences

- **新包 `@folio/platforms2`**(临时名,规避与现有 `@folio/platforms` 冲突):`src/{balance.ts, creds.ts, platforms/*.ts, registry.ts, index.ts}`,platform 一文件、provider 实现内联。删除 `packages/balances/*` 9 包及所有 `@folio/balances*` 引用。旧 `@folio/platforms`(链/场馆元数据,仍被 logo 代理 #20 用)本次不动,删除/归位为后续步骤。
- **改 CLAUDE.md 原则 #3**:原"每个 provider 独立包 `@folio/provider-*`" → "每个 platform 一个模块文件、provider 实现内联于其 manifest"。方案 A(工厂产多 type)相应变为"一个数据源(如 coinstats)出现在多个 platform 文件里"。
- **两 creds / 两校验**:`account.creds`(账户级)与 provider 的 `creds`(provider 级)靠所属对象区分;`validateAccount` / `validateCreds`(非 `validateKey`)。
- **Balance 判别联合是最大 blast radius**:overview-model / aggregate / account-view / 各展示组件全线适配(收益:去 cast、穷尽 switch)。
- **范围(本次)= 模型 + provider 重写,行为不变**:空配置 = 现状,全局 key 照旧走。运行时"启用/选 provider/配自定义 key/免重部署 + 类型管理 UI + 生命周期(关闭归档/切换)"作为**后续 phase**(旧 epic 目标不丢,分期做)。
- **迁移不双跑**:一次性切到新包再删旧(纯替换、行为不变,靠现有测试 + 四闸兜底)。
- **非领域概念** → CONTEXT.md 不加词条。
