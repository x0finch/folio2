import { createServerFn } from "@tanstack/react-start";
import { requireAuth } from "../session/require-auth";
import { handleGetConnectorCredentialSpecs } from "./credential-specs";
import { handleListConnectors } from "./list";

// connector 资源面:只做装配,实现在 ./list、./credential-specs(其 registry 引 cloudflare:workers,
// 经 createServerFn 编译剥离,不进客户端 bundle;故本文件对客户端安全可 import)。

export const listConnectors = createServerFn({ method: "GET" })
  .middleware([requireAuth])
  .handler(handleListConnectors);

export const getConnectorCredentialSpecs = createServerFn({ method: "GET" })
  .middleware([requireAuth])
  .handler(handleGetConnectorCredentialSpecs);
