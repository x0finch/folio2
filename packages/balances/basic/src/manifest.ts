import type { BalanceProvider, ProviderInput } from "./provider";
import type { AccountType } from "./types";

// Provider 自描述清单(ADR 0009)—— provider 注册进哪个 accountType 的【唯一事实源】(provider 实现本身
// 不带 accountType,只有纯行为)。类型放本包(契约地基)而非 @folio/provider-registry:provider 包导出
// entries 需要它,而 @folio/provider-registry 反向 import 各 provider 包集中组装 —— 类型在此才无环。
export interface ProviderManifest {
  // 全局唯一 id(kebab,如 "evm-zerion")。配置覆盖行按它寻址;跨版本稳定,不可改。
  readonly id: string;
  // 注册进哪个账户类型(registry 按它分桶出候选集合)。
  readonly accountType: AccountType;
  // 数据后端标识(如 "zerion" / "blockbook" / "coinstats");同 type 多后端 = 多个独立 entry(方案 A)。
  readonly dataSource: string;
  // 全局设置的字段声明(如全局 apiKey;复用 ProviderInput 自描述)。空 = 无全局设置,开箱即用。
  readonly configSchema: readonly ProviderInput[];
  // 「默认 key 槽」:configSchema 字段 → 部署时注入的 env 变量名(如 apiKey → ZERION_API_KEY)。
  // 分层解析(@folio/provider-registry resolveSettings):用户自定义(D1)→ 此 env 默认 → 缺失。
  readonly envDefaults?: Readonly<Record<string, string>>;
  // 默认启用与否:免费额度/公共数据/无需 key → true;要付费 key/冷门 → false。
  // 生效 = 启用状态(配置行覆盖 ?? 本默认)且配置解析链能给出必需的 key(见 @folio/provider-registry)。
  readonly defaultEnabled: boolean;
}

// provider 包的导出单元:manifest + 工厂(ADR 0009 两层构造:启用类型 = 以全局 settings 实例化;
// 账户级输入仍走 FetchContext.creds)。无全局设置的 provider:create 忽略入参返回单例。
export interface ProviderEntry {
  readonly manifest: ProviderManifest;
  readonly create: (settings?: Record<string, string>) => BalanceProvider;
}
