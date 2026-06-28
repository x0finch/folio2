import type { StandardSchemaV1 } from "@standard-schema/spec";
import type { Account, AccountType, Balance } from "./types";

// 账户输入的【自描述声明】:每个 provider 通过 BalanceProvider.inputs 列明它需要哪些输入。
// app 据此派生:录入/补录表单字段、创建/同步时的凭据校验、导出剥密钥。
// - type:"text"=普通(文本框、导出保留);"secret"=敏感(password、加密落库、导出剥离)。敏感性即 type。
// - validator:用 Standard Schema(zod v4 等均实现)→ 契约不绑定具体校验库,core 保持库无关。
export type ProviderInputType = "text" | "secret";
export interface ProviderInput {
  readonly key: string; // 存进 creds 的字段名(provider 自定;creds 形状由 inputs 推断)
  readonly type: ProviderInputType;
  readonly validator: StandardSchemaV1<unknown, string>;
  // 人类可读标签;同时【兼作 i18n key】(源串即 key,gettext 风格):app 在 Inputs namespace 下查翻译,
  // 缺翻译则回退 label 本身(英文)→ en 无需写、只补 zh。不同 provider 同 key 可给不同 label。desc 同理。
  readonly label: string;
  readonly desc?: string;
}

// 从声明的 inputs 推出该 provider 的 creds 形状(只含其字段、均为已校验的 string)。
// 默认(未具体化的 inputs)退化为 Record<string,string>,正是 sync 边界拿到的运行时形状。
export type CredsOf<I extends readonly ProviderInput[]> = {
  readonly [K in I[number]["key"]]: string;
};

// provider 拉取/校验时拿到的账户上下文。creds 形状由各 provider 的 inputs 推断(见 CredsOf);
// 运行时由 sync/创建流在构造前用 validateCredentials(inputs, …) 校验过 → 类型有运行时背书。
// globalKeys 已按本 provider 的 usesGlobalKeys 收窄(最小权限)。account.data 为类型相关数据。
export interface FetchContext<C = Record<string, string>> {
  account: Account;
  creds: C;
  globalKeys: Record<string, string>;
}

export interface BalanceProvider<I extends readonly ProviderInput[] = readonly ProviderInput[]> {
  // 该实现服务于哪个 AccountType —— "provider ↔ type" 映射的唯一事实源,registry 据此自动组装。
  readonly accountType: AccountType;
  // 本 provider 用到的服务端全局 key 名(最小权限,编排层据此收窄 globalKeys)。默认无。
  readonly usesGlobalKeys?: readonly string[];
  // 本 type 账户需要的【账户输入】(自描述,见 ProviderInput)。creds 形状(CredsOf)由它推断。
  // 链上/perp → [identifier(text)];binance → [apiKey,secret(secret)];okx → +passphrase;manual → []。
  readonly inputs?: I;
  /** 拉取该账户当前全部余额。失败抛 ProviderError。 */
  fetchBalances(ctx: FetchContext<CredsOf<I>>): Promise<Balance[]>;
  /** 校验账户上下文是否可用,加账户时调用。 */
  validate(ctx: FetchContext<CredsOf<I>>): Promise<boolean>;
}

// 定义 provider 的工厂:`const I` 从字面量 inputs 推断,使 fetchBalances/validate 的 ctx.creds
// 精确成 CredsOf<inputs>(如 okx → {apiKey,secret,passphrase})。返回擦除版 BalanceProvider 供注册表
// 异构存储。不用工厂、直接 `: BalanceProvider` 注解会让 I 退化成默认(失去推断)。
export function defineProvider<const I extends readonly ProviderInput[]>(
  provider: BalanceProvider<I>,
): BalanceProvider {
  return provider as BalanceProvider;
}
