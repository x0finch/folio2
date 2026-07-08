import type { ProviderEntry } from "@folio/balances-basic";
import { entries as binanceEntries } from "@folio/balances-provider-binance";
import { entries as bitcoinEntries } from "@folio/balances-provider-bitcoin";
import { entries as coinstatsEntries } from "@folio/balances-provider-coinstats";
import { entries as customEntries } from "@folio/balances-provider-custom";
import { entries as hyperliquidEntries } from "@folio/balances-provider-hyperliquid";
import { entries as okxEntries } from "@folio/balances-provider-okx";
import { entries as zerionEntries } from "@folio/balances-provider-zerion";

// 应用级组装点(全仓唯一的 provider 包 import 清单)。新增 provider 包 → 在此 import 并摊平;
// 其余一切(type 映射/启用/配置)由各包 manifest + 覆盖表驱动,不再有 type→provider 硬编码。
export const ALL_ENTRIES: ProviderEntry[] = [
  ...customEntries,
  ...zerionEntries,
  ...bitcoinEntries,
  ...coinstatsEntries,
  ...binanceEntries,
  ...okxEntries,
  ...hyperliquidEntries,
];
