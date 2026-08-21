import { createServerFn } from "@tanstack/react-start";
import { requireAuth } from "@/lib/server/session/require-auth";
import { connectorCatalog, credentialSpecs } from "./registry";

// connector 资源面。两个 handler 都是零逻辑转发(不收 data/context、不做任何绑定),按
// CODING.md「别造无逻辑的转发」直接内联 —— registry 的真函数本就可直测,抽文件没有增益。
// registry 引 cloudflare:workers,但只在 handler 体内引用 → 经 createServerFn 编译剥离,
// 不进客户端 bundle;故本文件对客户端安全可 import。

// connector 展示名/logo 目录(connectorId → {label, logo});客户端经 connectorCatalogQuery 消费。
export const listConnectors = createServerFn({ method: "GET" })
  .middleware([requireAuth])
  .handler(() => connectorCatalog());

// 各 connector 的账户输入规格(录入/补录表单动态生成字段用:secret→password、OKX 才有 passphrase)。
export const getConnectorCredentialSpecs = createServerFn({ method: "GET" })
  .middleware([requireAuth])
  .handler(() => credentialSpecs());
