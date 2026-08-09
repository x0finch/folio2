import { queryOptions } from "@tanstack/react-query";
import { getConnectorCredentialSpecs, listConnectors } from "../server/connectors";
import { STALE_TIME } from "./constants";
import { connectorKeys } from "./keys";

// 连接器域的读取入口。**这个域没有写操作** —— 它整份来自 registry,跟着部署走,
// 所以刷新映射表里没有它的条目,`staleTime` 也给到最长的一档。

export const connectorCatalogQuery = () =>
  queryOptions({
    queryKey: connectorKeys.catalog(),
    queryFn: () => listConnectors(),
    staleTime: STALE_TIME.deployment,
  });

export const connectorCredentialSpecsQuery = () =>
  queryOptions({
    queryKey: connectorKeys.credentialSpecs(),
    queryFn: () => getConnectorCredentialSpecs(),
    staleTime: STALE_TIME.catalogue,
  });
