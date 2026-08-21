import { connectorCatalog } from "./registry";

// connector 展示名/logo 目录(connectorId → {label, logo});客户端经 connectorCatalogQuery 消费。
export function handleListConnectors() {
  return connectorCatalog();
}
