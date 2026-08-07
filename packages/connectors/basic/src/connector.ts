import type { Outbound } from "@folio/client-core";
import type { Effect } from "effect";
import type { z } from "zod";
import type { Balance } from "./balance";
import type { ConnectorError } from "./connector-error";
import type { CredField, CredsOf } from "./creds";
import type { Note } from "./note";

// 【Connector 契约】(ADR 0009)。一个 connector = 我们支持的一类账户;一份自包含 manifest 绑定
// account.creds + balance.schema + providers。Connector ≠ Platform(后者是链∪场馆展示维度)。

// provider 取数/校验拿到的上下文:两组 creds 都类型化 —— 账户级 AC 从 connector.account.creds 下来,
// provider 级 PC 是本 provider 自身配置(scope-A 恒空)。
// provider 干活需要的能力:**出网**。写进 `R` 通道而不是让每个 provider 自己 provide 一个 ——
// 后者的话测试就换不掉它了(provider 内部 provide 的东西,外面盖不住)。装配那头(`apps/web`)
// 提供 `FolioHttpClient`,测试提供一个假的,provider 只声明「我需要」。
//
// `import type` —— 类型在编译期就没了,`@folio/connectors-basic` 仍然是那个能安全进客户端包的契约层
// (它被 `apps/web/src/lib/*` 引用)。**别在本包里对 `@folio/client-core` 做值导入**,那会把整个
// HTTP 层拖进客户端 bundle。
export type ProviderNeeds = Outbound;

export interface FetchContext<AC = Record<string, unknown>, PC = Record<string, unknown>> {
  readonly account: { id: string; label: string; connectorId: string; creds: AC };
  readonly creds: PC;
}

export interface BalanceProvider<
  B extends Balance,
  AC extends readonly CredField[] = readonly CredField[],
  PC extends readonly CredField[] = readonly CredField[],
> {
  readonly id: string;
  readonly label: string;
  readonly creds: PC; // 实例化本 provider 要的 key(空 = 开箱即用)
  readonly defaultEnabled?: boolean;
  // 返回该 connector 的 balances(B 子集;balance 级单个 note 挂在各 balance 上)+ 顶层可选 account 级 note(Note[],整钱包)。
  //
  // **出口是 `Effect` 不是 `Promise`**(ADR 0035):中途转一次 Promise 会切断 context ——
  // 外层的超时和中断管不到里面,`TestClock` 也驱动不了(sync 迁移时实测过)。
  fetchBalances(
    ctx: FetchContext<CredsOf<AC>, CredsOf<PC>>,
  ): Effect.Effect<{ balances: B[]; note?: Note[] }, ConnectorError, ProviderNeeds>;
  // 账户 liveness。**语义收窄成一件事:上游对这份凭据说不说 yes。** 两类失败别压成同一个 false:
  //   · 凭据被上游拒(401/403 / 业务码说不对)或凭据本身不成立 → 成功返回 `false`
  //     (等也没用,不该重试)。
  //   · 够不到上游(429 / 5xx / 网络故障 / 坏响应)→ **走错误通道**,调用方据 `_tag` 决定重试
  //     (与 fetchBalances 同口径)。
  // 压成 false 会让瞬时 429 显示成「凭据错误」、还让上层的重试永远触发不了。
  //
  // (`false` 也可以并进错误通道 —— `ConnectorAuthError` 本来就是那个意思。没并是因为那要改
  //  9 个 provider 的内部,而本片刻意只动契约形状;B2 各片接线时顺手改。)
  validateAccount(
    ctx: FetchContext<CredsOf<AC>, CredsOf<PC>>,
  ): Effect.Effect<boolean, ConnectorError, ProviderNeeds>;
}

// 估值语义:provider 的 value 权不权威。authoritative(默认)= 场馆/链上自带权威 USD 估值,
// 富化不重算(enrich-not-reprice);mark-to-market = 无权威价、恒按市场源价盯市(如 manual 只录量、
// bitcoin 只产已确认 amount)。由 connector 在 manifest 自声明 —— 消费方(app revalue)据此决定
// 是否捕获自带单价 / 恒用源价,第三方 connector 也能自带该语义(不再靠 app 侧硬编码名单)。
export type ConnectorValuation = "authoritative" | "mark-to-market";

// 擦除版 manifest —— 异构 registry 存储用。具体泛型(AC / 该 connector 的 B 子集 / 各 provider PC)
// 只在 defineConnector 站点存在并做编译期校验,进 registry 后擦除到 Balance 全集。
export interface ConnectorManifest {
  readonly id: string; // connectorId(取代 accountType)
  readonly label: string;
  readonly logo: string;
  readonly account: { readonly creds: readonly CredField[] };
  readonly balance: {
    readonly schema: z.ZodType<Balance>;
    readonly providers: readonly BalanceProvider<Balance>[];
  };
  readonly valuation?: ConnectorValuation; // 缺省 authoritative
}

// defineConnector 仅为【类型推断】存在:schema 是事实源、`B = z.infer<S>`(绝不 z.ZodType<B> 注解,
// zod v4 footgun);const AC 让 account.creds 精确;把 AC / B 灌进内联的各 provider,写错 kind 编译即挂
//(BalanceProvider 的 `B extends Balance` 约束会拒绝非 Balance 子集的 schema)。返回擦除版供 registry 异构存储。
export function defineConnector<
  S extends z.core.$ZodType<Balance>,
  const AC extends readonly CredField[],
  const Id extends string = string,
>(m: {
  id: Id;
  label: string;
  logo: string;
  account: { creds: AC };
  balance: { schema: S; providers: BalanceProvider<z.infer<S>, AC>[] };
  valuation?: ConnectorValuation;
}): ConnectorManifest & { readonly id: Id } {
  // 保留字面量 id(#37d:entry registry 据此派生 ConnectorId 联合),仍向下兼容擦除版 ConnectorManifest。
  return m as unknown as ConnectorManifest & { readonly id: Id };
}
