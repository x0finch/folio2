import { useQuery } from "@tanstack/react-query";
import { getConnectorCatalog } from "./server/credentials";

// 连接器展示名(来自 registry,经 server fn;部署内静态 → staleTime Infinity,全局缓存一次)。
// 返回 (id)=>label,未命中回落 id(首帧目录未到位时先显 id,加载后即换成展示名)。
export function useConnectorLabels(): (connectorId: string) => string {
  const { data } = useQuery({
    queryKey: ["connectorCatalog"],
    queryFn: () => getConnectorCatalog(),
    staleTime: Number.POSITIVE_INFINITY,
  });
  return (connectorId) => data?.[connectorId] ?? connectorId;
}
