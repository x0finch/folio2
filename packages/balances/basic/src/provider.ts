import type { StandardSchemaV1 } from "@standard-schema/spec";
import type { Account, AccountType, Balance } from "./types";

// 账户输入的【自描述声明】:每个 provider 通过 BalanceProvider.inputs 列明它需要哪些输入。
// app 据此派生:录入/补录表单字段、创建/同步时的凭据校验、导出处理。
// - type = 单轴【暴露级别】(at-rest 一律加密落库,type 只决定"导出怎么处理"+ 输入框):
//     "public" = 全留:文本框、导出原样保留、导入可重建(如地址 identifier)
//     "semi"   = 部分留:文本框、导出【打码保留】(如 abc12…wxyz)、不可重建但供补录时识别(如 apiKey)
//     "secret" = 不留:password、导出剥离(签名 secret / passphrase)
//   "能被人认出"是部分暴露的自然副产物,不是另一个职责 —— type 仍纯粹是暴露级别。
// - validator:用 Standard Schema(zod v4 等均实现)→ 契约不绑定具体校验库,core 保持库无关。
export type ProviderInputType = "public" | "semi" | "secret";
// 值类型 T 由 validator 推断(string / number / …):provider 即"input 类型 → output 类型"的 map。
// 默认 T=unknown(即"任意值类型的 input"),让辅助函数/约束写裸 `ProviderInput[]` 即可接受异构 inputs;
// 具体 T(如 amount 的 number)在 defineProvider 的 const 字面量推断里由 validator 给出(P6.6.2)。
export interface ProviderInput<T = unknown> {
  readonly key: string; // 存进 creds 的字段名(provider 自定;creds 形状由 inputs 推断)
  readonly type: ProviderInputType;
  readonly validator: StandardSchemaV1<unknown, T>;
  // 人类可读标签;同时【兼作 i18n key】(源串即 key,gettext 风格):app 在 Inputs namespace 下查翻译,
  // 缺翻译则回退 label 本身(英文)→ en 无需写、只补 zh。不同 provider 同 key 可给不同 label。desc 同理。
  readonly label: string;
  readonly desc?: string;
}

// 从声明的 inputs 推出该 provider 的 creds 形状:每个字段 → 其 validator 的输出类型(异构)。
// 默认(未具体化的 inputs)退化为 Record<string, unknown>,正是 sync 边界拿到的运行时形状。
export type CredsOf<I extends readonly ProviderInput[]> = {
  readonly [E in I[number] as E["key"]]: E extends ProviderInput<infer T> ? T : never;
};

// provider 拉取/校验时拿到的账户上下文。creds 形状由各 provider 的 inputs 推断(见 CredsOf);
// 运行时由 sync/创建流在构造前用 validateCredentials(inputs, …) 校验过 → 类型有运行时背书。
// globalKeys 已按本 provider 的 usesGlobalKeys 收窄(最小权限)。
export interface FetchContext<C = Record<string, unknown>> {
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
  // 链上/perp → [identifier(public)];binance → [apiKey(semi),secret];okx → +passphrase;manual → [symbol,amount,usdValue(public)]。
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
