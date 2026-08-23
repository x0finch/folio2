import { createServerFn } from "@tanstack/react-start";
import { runEffect, runForUser } from "@/lib/server/runtime";
import { requireAuth } from "@/lib/server/session/require-auth";
import { handleGetSyncStatus } from "./get-status";
import { handleSyncAccount, SyncAccountInput } from "./run";

// sync 资源面:只做装配(method / 鉴权 / 校验),实现与入参 schema 在 ./run、./get-status。
// handler 及其 import 链(oracle → cloudflare:workers)由 Start 编译器从客户端 bundle 剥离,
// 故本文件对客户端安全可 import(#499 探针实证)。

// **这一条不走 `runEffect`**:同步内核要一个 userId 标日志(理由见 ./run 的注释),
// 而 `runEffect` 刻意不把 userId 交给 handler。`runForUser` 是同一个内核,只是人由这里接。
export const syncAccount = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .validator(SyncAccountInput)
  .handler(({ data, context }) =>
    runForUser(context.userId, handleSyncAccount(context.userId, data)),
  );

export const getSyncStatus = createServerFn({ method: "GET" })
  .middleware([requireAuth])
  .handler(runEffect(handleGetSyncStatus));
