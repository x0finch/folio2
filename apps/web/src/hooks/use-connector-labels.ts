import { useQuery } from "@tanstack/react-query";
import { connectorLabelFallback } from "../lib/connector-label";
import { connectorCatalogQuery } from "../lib/queries/connectors";

// 连接器展示目录(connectorId → {label, logo},来自 registry,经 server fn;部署内静态 → staleTime Infinity,
// 全局缓存一次)。label/logo 两个 hook 共用同一 query(React Query 按 key 去重,不多发请求)。
function useConnectorCatalog() {
  return useQuery(connectorCatalogQuery());
}

// (id)=>展示名。未命中**不再回落成裸 id**(那会把 `hyperliquid` / `okx` 印在界面上,#467),
// 而是回落成像名字的名字(见 connectorLabelFallback)。渲染徽标的路由还会在 loader 里预取这份目录,
// 所以正常路径上根本走不到兜底。
export function useConnectorLabels(): (connectorId: string) => string {
  const { data } = useConnectorCatalog();
  return (connectorId) => data?.[connectorId]?.label ?? connectorLabelFallback(connectorId);
}

// (id)=>已代理 logo url(manifest 自带图);未命中/无图 → undefined(调用方回退首字母)。
export function useConnectorLogos(): (connectorId: string) => string | undefined {
  const { data } = useConnectorCatalog();
  return (connectorId) => data?.[connectorId]?.logo;
}
