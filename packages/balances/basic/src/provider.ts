import type { StandardSchemaV1 } from "@standard-schema/spec";
import type { Account, Balance } from "./types";

// 账户输入的【自描述声明】。**归属 accountType 数据约束层**(ADR 0009 两层:见 @folio/provider-registry
// ACCOUNT_TYPE_SPECS),不再挂在 provider 上 —— 一个类型的账户长什么样与用哪个 provider 取数无关。
// - type = 单轴【暴露级别】(at-rest 一律加密落库,type 只决定"导出怎么处理"+ 输入框):
//     "public" = 全留:文本框、导出原样、可重建(如地址 identifier)
//     "semi"   = 部分留:文本框、导出【打码保留】供补录识别(如 apiKey)
//     "secret" = 不留:password、导出剥离(签名 secret / passphrase)
// - validator:Standard Schema(zod 等实现)→ 契约不绑定具体校验库。
export type ProviderInputType = "public" | "semi" | "secret";
export interface ProviderInput<T = unknown> {
  readonly key: string;
  readonly type: ProviderInputType;
  readonly validator: StandardSchemaV1<unknown, T>;
  // 人类可读标签,兼作 i18n key(Inputs namespace;缺翻译回退 label 本身)。desc 同理。
  readonly label: string;
  readonly desc?: string;
}

// provider 拉取/校验时拿到的账户上下文。creds 形状 = accountType 层 accountInputs 的校验输出;
// provider 各自本地标注期望的 C(如 { identifier: string })。运行时由 validateCredentials 校验过 → 有背书。
// 全局 key 不在此:它是 provider 的【实例化参数】(ProviderEntry.create(settings),ADR 0009)。
export interface FetchContext<C = Record<string, unknown>> {
  account: Account;
  creds: C;
}

// provider 层(ADR 0009):纯行为 —— 只管取数 + 两个 liveness 校验,不带身份。
// 注册进哪个 AccountType 由 ProviderManifest.accountType 声明(唯一事实源),provider 实现不再重复。
export interface BalanceProvider {
  /** 拉取该账户当前全部余额(账户级 creds 走 ctx.creds;全局 config 已在实例化时注入)。失败抛 ProviderError。 */
  fetchBalances(ctx: FetchContext): Promise<Balance[]>;
  /** 账户 liveness(输入 5):加账户时校验这份账户 creds 经本 provider 能否取到数。 */
  validateAccount(ctx: FetchContext): Promise<boolean>;
  /**
   * 配置 liveness(输入 4,可选):启用/改 key 时校验注入的全局 config(如 API key)是否可用。
   * 打一个【只需 config、不需 account】的探活端点;无此能力的 provider 不声明(退化到形状校验)。
   */
  validateConfig?(): Promise<boolean>;
}
