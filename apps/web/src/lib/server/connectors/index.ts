import { createServerFn } from "@tanstack/react-start";
import { Effect } from "effect";
import { runEffect } from "@/lib/server/runtime";
import { requireAuth } from "@/lib/server/session/require-auth";
import { ConnectorRegistry } from "./registry";

// connector 资源面。两个 handler 都是零逻辑转发(只是从门票上取一个字段),按
// CODING.md「别造无逻辑的转发」直接内联 —— registry 的真东西本就可直测,抽文件没有增益。
// registry 引 cloudflare:workers,但只在 handler 体内引用 → 经 createServerFn 编译剥离,
// 不进客户端 bundle;故本文件对客户端安全可 import。

// connector 展示名/logo 目录(connectorId → {label, logo});客户端经 connectorCatalogQuery 消费。
export const listConnectors = createServerFn({ method: "GET" })
  .middleware([requireAuth])
  .handler(
    runEffect(
      Effect.fn("listConnectors")(function* () {
        return (yield* ConnectorRegistry).catalog;
      }),
    ),
  );

// 各 connector 的账户输入规格(录入/补录表单动态生成字段用:secret→password、OKX 才有 passphrase)。
export const getConnectorCredentialSpecs = createServerFn({ method: "GET" })
  .middleware([requireAuth])
  .handler(
    runEffect(
      Effect.fn("getConnectorCredentialSpecs")(function* () {
        return (yield* ConnectorRegistry).specs;
      }),
    ),
  );
