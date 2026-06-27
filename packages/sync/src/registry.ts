import { buildRegistry } from "@folio/core";
import { providers as binanceProviders } from "@folio/provider-binance";
import { providers as coinstatsProviders } from "@folio/provider-coinstats";
import { providers as customProviders } from "@folio/provider-custom";
import { providers as zerionProviders } from "@folio/provider-zerion";

// 应用级 provider 装配(方案 A 摊平):收集各 provider 包导出的 providers,
// 由 buildRegistry 按各自 accountType 自动组装。新增 provider 包 → 在此 import 并摊平。
// coinstats 是多类型包(一个包导出多个 provider 对象),摊平后各自登记。
export const appProviders = [
  ...customProviders,
  ...zerionProviders,
  ...coinstatsProviders,
  ...binanceProviders,
];
export const appRegistry = buildRegistry(appProviders);
