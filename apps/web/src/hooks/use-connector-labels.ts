import { useQuery } from "@tanstack/react-query";
import { listConnectors } from "../lib/server/connectors";

// 连接器展示目录(connectorId → {label, logo},来自 registry,经 server fn;部署内静态 → staleTime Infinity,
// 全局缓存一次)。label/logo 两个 hook 共用同一 query(React Query 按 key 去重,不多发请求)。
function useConnectorCatalog() {
  return useQuery({
    queryKey: ["connectorCatalog"],
    queryFn: () => listConnectors(),
    staleTime: Number.POSITIVE_INFINITY,
  });
}

// (id)=>展示名,未命中回落 id(首帧目录未到位时先显 id,加载后即换成展示名)。
export function useConnectorLabels(): (connectorId: string) => string {
  const { data } = useConnectorCatalog();
  return (connectorId) => data?.[connectorId]?.label ?? connectorId;
}

// (id)=>已代理 logo url(manifest 自带图);未命中/无图 → undefined(调用方回退首字母)。
export function useConnectorLogos(): (connectorId: string) => string | undefined {
  const { data } = useConnectorCatalog();
  return (connectorId) => data?.[connectorId]?.logo;
}
