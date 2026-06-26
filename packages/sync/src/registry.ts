import { buildRegistry } from "@folio/core";
import { providers as customProviders } from "@folio/provider-custom";
import { providers as zerionProviders } from "@folio/provider-zerion";

// 应用级 provider 装配(方案 A 摊平):收集各 provider 包导出的 providers,
// 由 buildRegistry 按各自 accountType 自动组装。新增 provider 包 → 在此 import 并摊平。
export const appProviders = [...customProviders, ...zerionProviders];
export const appRegistry = buildRegistry(appProviders);
