import { createServerFn } from "@tanstack/react-start";
import { runEffect, runTimedForUser } from "@/lib/server/runtime";
import { requireAuth } from "@/lib/server/session/require-auth";
import { CreateActivitiesInput, handleCreateManualActivitiesFor } from "./create";
import { handleRemoveManualActivity, RemoveActivityInput } from "./remove";
import { handleUpdateManualActivityFor, UpdateActivityInput } from "./update";

// manual 活动账本资源面(账户级):只做装配(auth + 校验),schema 与实现同住各动作文件,
// 决策/物化在 ../manual/store。
//
// **加 / 改两条不走 `runEffect`**(FOL-90):写成功之后要投一条带 userId 的 `daily-prices`,而
// `runEffect` 刻意不把 userId 交给 handler —— 同 `sync/index` 的 `syncAccount`,人由这里接。

export const createManualActivities = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .validator(CreateActivitiesInput)
  .handler(({ data, context }) =>
    runTimedForUser(
      context.userId,
      "createManualActivities",
      handleCreateManualActivitiesFor(context.userId, data),
    ),
  );

export const removeManualActivity = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .validator(RemoveActivityInput)
  .handler(runEffect(handleRemoveManualActivity));

export const updateManualActivity = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .validator(UpdateActivityInput)
  .handler(({ data, context }) =>
    runTimedForUser(
      context.userId,
      "updateManualActivity",
      handleUpdateManualActivityFor(context.userId, data),
    ),
  );
