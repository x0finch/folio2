import { queryOptions } from "@tanstack/react-query";
import { getConnectorCredentialSpecs, listConnectors } from "@/lib/server/connectors";
import { STALE_TIME } from "./constants";
import { connectorKeys } from "./keys";

// 连接器域的读取入口。**这个域没有写操作** —— 两条查询都是 registry 派生的纯函数结果
//(`listConnectors` / `credentialSpecs()`),同一个部署里问第二次不可能得到不同答案。
// 所以刷新映射表里没有它的条目,两条的 `staleTime` 都给到最长的一档。
// (凭据字段规格原先给的是 `catalogue`(1h) —— 与上面这句不符,而它和连接器清单同源,
// 没有理由比它短。)

export const connectorCatalogQuery = () =>
  queryOptions({
    queryKey: connectorKeys.catalogue(),
    queryFn: () => listConnectors(),
    staleTime: STALE_TIME.deployment,
  });

export const connectorCredentialSpecsQuery = () =>
  queryOptions({
    queryKey: connectorKeys.credentialSpecs(),
    queryFn: () => getConnectorCredentialSpecs(),
    staleTime: STALE_TIME.deployment,
  });
