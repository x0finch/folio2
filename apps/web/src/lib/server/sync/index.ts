import { createServerFn } from "@tanstack/react-start";
import { runEffect, runTimedForUser } from "@/lib/server/runtime";
import { requireAuth } from "@/lib/server/session/require-auth";
import { GetSyncStatusInput, handleGetSyncStatus } from "./get-status";
import { GetSyncRoundInput, handleGetSyncRound } from "./round";
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
    runTimedForUser(context.userId, "syncAccount", handleSyncAccount(context.userId, data)),
  );

// 收一个 portfolioId:摘要按选中的 Portfolio 收口(ADR 0033),而选中态只在客户端(不持久化),
// 所以它必须显式传进来 —— 服务端没有第二条路知道你在看哪个。
export const getSyncStatus = createServerFn({ method: "GET" })
  .middleware([requireAuth])
  .validator(GetSyncStatusInput)
  .handler(runEffect(handleGetSyncStatus));

// 这一轮进行到哪(ADR 0048)。**busy 时 1.5s 一发的就是它** —— 所以它只读一个键,
// 而上面那份摘要保持低频:轮询该盯着唯一在变的东西,不该反复重算只有落库才变的那份。
export const getSyncRound = createServerFn({ method: "GET" })
  .middleware([requireAuth])
  .validator(GetSyncRoundInput)
  .handler(runEffect(handleGetSyncRound));
