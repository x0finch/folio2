import type { z } from "zod";
import type { Balance } from "./balance";
import type { CredField, CredsOf } from "./creds";
import type { Note } from "./note";

// 【Connector 契约】(ADR 0009)。一个 connector = 我们支持的一类账户;一份自包含 manifest 绑定
// account.creds + balance.schema + providers。Connector ≠ Platform(后者是链∪场馆展示维度)。

// provider 取数/校验拿到的上下文:两组 creds 都类型化 —— 账户级 AC 从 connector.account.creds 下来,
// provider 级 PC 是本 provider 自身配置(scope-A 恒空)。
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
  fetchBalances(
    ctx: FetchContext<CredsOf<AC>, CredsOf<PC>>,
  ): Promise<{ balances: B[]; note?: Note[] }>;
  validateAccount(ctx: FetchContext<CredsOf<AC>, CredsOf<PC>>): Promise<boolean>; // 账户 liveness
  validateCreds?(creds: CredsOf<PC>): Promise<boolean>; // provider 自身 creds liveness
}

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
}): ConnectorManifest & { readonly id: Id } {
  // 保留字面量 id(#37d:entry registry 据此派生 ConnectorId 联合),仍向下兼容擦除版 ConnectorManifest。
  return m as unknown as ConnectorManifest & { readonly id: Id };
}
