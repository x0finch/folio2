import { createServerFn } from "@tanstack/react-start";
import { connectorCatalog, credentialSpecs } from "./internal/connector-registry";
import { requireAuth } from "./internal/require-auth";

// connector 资源的 server fn 门面(客户端经此调用)。实现(connector-registry,引 cloudflare:workers)
// 只在 handler 体内引用 → 经 createServerFn 编译剥离,不进客户端 bundle;故本文件对客户端安全可 import。

// connector 展示名/logo 目录(connectorId → {label, logo});客户端经 useConnectorLabels 消费。
export const listConnectors = createServerFn({ method: "GET" })
  .middleware([requireAuth])
  .handler(() => connectorCatalog());

// 各 connector 的账户输入规格(录入/补录表单动态生成字段用:secret→password、OKX 才有 passphrase)。
export const getConnectorCredentialSpecs = createServerFn({ method: "GET" })
  .middleware([requireAuth])
  .handler(() => credentialSpecs());
