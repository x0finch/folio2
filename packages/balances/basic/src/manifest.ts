import type { BalanceProvider, ProviderInput } from "./provider";

// Provider 自描述清单(ADR 0009)—— registry 组装与运行时启用/配置的唯一事实源。
// 类型放本包(契约地基)而非 @folio/provider-registry:provider 包导出 entries 需要它,
// 而 @folio/provider-registry 反向 import 各 provider 包做集中组装 —— 类型在此才无环。
export interface ProviderManifest {
  // 全局唯一 id(kebab,如 "evm-zerion")。配置覆盖行按它寻址;跨版本稳定,不可改。
  readonly id: string;
  // 服务的账户类型(与 BalanceProvider.accountType 一致;registry 按它分桶出候选集合)。
  readonly accountType: BalanceProvider["accountType"];
  // 数据后端标识(如 "zerion" / "blockbook" / "coinstats");同 type 多后端 = 多个独立 entry(方案 A)。
  readonly dataSource: string;
  // 全局设置的字段声明(如全局 apiKey;复用 ProviderInput 自描述)。空 = 无全局设置,开箱即用。
  readonly configSchema: readonly ProviderInput[];
  // 默认启用与否:免费额度/公共数据/无需 key → true;要付费 key/冷门 → false。
  // 生效 = 启用状态(配置行覆盖 ?? 本默认)且配置解析链能给出必需的 key(见 @folio/provider-registry)。
  readonly defaultEnabled: boolean;
}

// provider 包的导出单元:manifest + 实现。@folio/provider-registry 收集各包 entries 组装 registry。
export interface ProviderEntry {
  readonly manifest: ProviderManifest;
  readonly provider: BalanceProvider;
}
