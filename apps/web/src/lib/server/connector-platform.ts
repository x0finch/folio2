import { getConnector, registry } from "@folio/connectors";

// 平台键 → 连接器自带的展示元数据(name+logo)。场馆/manual 持仓的平台键**即 connectorId**
// (binance/okx/hyperliquid/manual,见 aggregate.platformIdOf):name+logo 连接器 manifest 已有,
// 无需再经 @folio/platforms 查 CoinGecko(去多余往返,#52)。
// 链键(chain:<slug> / eip155:<id>)不是 connectorId → getConnector 返回 undefined → null → 走 platforms 逐链查。
// 服务端专用(引 registry)。manual 无 logo(""→undefined)→ UI 走内置 WalletIcon。
export function connectorPlatformMeta(
  key: string,
): { key: string; name: string; logo?: string } | null {
  // 平台键通常即 connectorId(binance/okx/hyperliquid/manual)。原生链持仓的平台键是链键 `chain:<slug>`
  // (见 aggregate.platformIdOf),其 slug 往往就是同名连接器 id(chain:bitcoin→bitcoin、chain:solana→solana):
  // 这类原生链 CoinGecko asset_platforms 常无图(如 bitcoin),而连接器 manifest 自带图 → 按 slug 认连接器、
  // 借它的 name+logo,免得回退成首字母。不匹配(eip155:* / 未知 slug)→ null,照走 platforms.resolve 逐链查。
  // 注:这是 Platform 借 Connector 图的务实兜底(跨概念),chain/platform 命名复核见 issue #122。
  const id = key.startsWith("chain:") ? key.slice("chain:".length) : key;
  const manifest = getConnector(registry, id);
  if (!manifest) return null;
  return { key, name: manifest.label, logo: manifest.logo || undefined };
}
