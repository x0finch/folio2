import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireAuth } from "../session/require-auth";
import { handleGetSyncStatus } from "./get-status";
import { handleSyncAccount } from "./run";

// sync 资源面:只做装配(method / 鉴权 / 校验),实现在 ./run、./get-status。
// handler 及其 import 链(oracle → cloudflare:workers)由 Start 编译器从客户端 bundle 剥离,
// 故本文件对客户端安全可 import(#499 探针实证)。

export const syncAccount = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .validator(z.object({ accountId: z.string().min(1) }))
  .handler(handleSyncAccount);

export const getSyncStatus = createServerFn({ method: "GET" })
  .middleware([requireAuth])
  .handler(handleGetSyncStatus);
