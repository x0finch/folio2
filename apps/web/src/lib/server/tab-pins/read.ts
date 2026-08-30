import { Database } from "@folio/db";
import { Effect } from "effect";
import { connectorLabelFallback, platformLogoUrl } from "@/lib/core/logo";
import type { PortfolioTabPinsData } from "@/lib/core/portfolio";
import { connectorPlatformMeta } from "@/lib/server/connectors/platform";

// 首页 tab 条 pin 原料 —— 只取 pin 行 + connector 展示元数据。账户 / 快照走 overview 缓存,
// 标签名走 tagListQuery 缓存;改 pin 只 invalidate 这一层。

const connectorMetaEntries = (
  pins: readonly { kind: string; connectorId: string | null }[],
): [string, { name: string; logo?: string }][] => {
  const keys = new Set<string>();
  for (const p of pins) {
    if (p.kind === "connector" && p.connectorId) keys.add(p.connectorId);
  }
  const out: [string, { name: string; logo?: string }][] = [];
  for (const key of keys) {
    const meta = connectorPlatformMeta(key);
    const logo = platformLogoUrl(key, meta?.logo);
    out.push([
      key,
      logo
        ? { name: meta?.name ?? connectorLabelFallback(key), logo }
        : { name: meta?.name ?? connectorLabelFallback(key) },
    ]);
  }
  return out;
};

export const handleGetPortfolioTabPins = Effect.fn("getPortfolioTabPins")(function* () {
  const pins = yield* (yield* Database).tabPins.list();
  return {
    pins,
    connectorMeta: connectorMetaEntries(pins),
  } satisfies PortfolioTabPinsData;
});
