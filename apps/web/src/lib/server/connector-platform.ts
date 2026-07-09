import { getConnector, registry } from "@folio/connectors";

// 平台键 → 连接器自带的展示元数据(name+logo)。仅对「一个连接器 = 一个平台」的场馆生效:
//   manual / exchange:<cid> / perp:<cid>
// 这些平台的 name+logo 连接器 manifest 已有(label/logo),无需再经 @folio/platforms 查 CoinGecko —— 去掉多余往返(#52)。
// 链键(chain:/eip155:)返回 null:一个链上连接器对多条链、连接器只有一张通用图,盖不住 → 仍走 platforms 逐链查。
// 服务端专用(引 registry)。manual 无 logo(""→undefined)→ UI 走内置 WalletIcon。
export function connectorPlatformMeta(
  key: string,
): { key: string; name: string; logo?: string } | null {
  let cid: string | null = null;
  if (key === "manual") cid = "manual";
  else if (key.startsWith("exchange:") || key.startsWith("perp:"))
    cid = key.slice(key.indexOf(":") + 1);
  if (!cid) return null;
  const manifest = getConnector(registry, cid);
  if (!manifest) return null;
  return { key, name: manifest.label, logo: manifest.logo || undefined };
}
