// @folio/balances —— 余额侧对外门面。转发单 provider 契约(@folio/balances-basic:BalanceProvider /
// defineProvider / creds / crypto / inputs / Balance 等)+ registry 机制(./registry)+ 应用级 provider 组装。
// 分层照 tokens:provider 实现依赖 @folio/balances-basic(纯契约,不含 registry);app / sync / db 一律从本门面
// 引余额相关的一切(含 buildRegistry / getProvider / ProviderRegistry / providers / registry)。

import { providers as binanceProviders } from "@folio/balances-provider-binance";
import { providers as coinstatsProviders } from "@folio/balances-provider-coinstats";
import { providers as customProviders } from "@folio/balances-provider-custom";
import { providers as hyperliquidProviders } from "@folio/balances-provider-hyperliquid";
import { providers as okxProviders } from "@folio/balances-provider-okx";
import { providers as zerionProviders } from "@folio/balances-provider-zerion";
import { buildRegistry } from "./registry";

export * from "@folio/balances-basic";
export { buildRegistry, getProvider, type ProviderRegistry } from "./registry";

// —— 应用级 provider 装配(方案 A 摊平)——
// 收集各 provider 包导出的 providers,由 buildRegistry 按各自 accountType 自动组装。新增 provider 包 →
// 在此 import 并摊平。coinstats 是多类型包(一包多 provider),摊平各自登记。
export const providers = [
  ...customProviders,
  ...zerionProviders,
  ...coinstatsProviders,
  ...binanceProviders,
  ...okxProviders,
  ...hyperliquidProviders,
];

export const registry = buildRegistry(providers);
