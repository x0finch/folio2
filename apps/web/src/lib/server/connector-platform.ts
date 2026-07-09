import { getConnector, registry } from "@folio/connectors";

// 平台键 → 连接器自带的展示元数据(name+logo)。场馆/manual 持仓的平台键**即 connectorId**
// (binance/okx/hyperliquid/manual,见 aggregate.platformIdOf):name+logo 连接器 manifest 已有,
// 无需再经 @folio/platforms 查 CoinGecko(去多余往返,#52)。
// 链键(chain:<slug> / eip155:<id>)不是 connectorId → getConnector 返回 undefined → null → 走 platforms 逐链查。
// 服务端专用(引 registry)。manual 无 logo(""→undefined)→ UI 走内置 WalletIcon。
export function connectorPlatformMeta(
  key: string,
): { key: string; name: string; logo?: string } | null {
  const manifest = getConnector(registry, key);
  if (!manifest) return null;
  return { key, name: manifest.label, logo: manifest.logo || undefined };
}
