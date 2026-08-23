import { createServerFn } from "@tanstack/react-start";
import { runEffect } from "@/lib/server/runtime";
import { requireAuth } from "@/lib/server/session/require-auth";
import { CreateActivitiesInput, handleCreateManualActivities } from "./create";
import { handleRemoveManualActivity, RemoveActivityInput } from "./remove";
import { handleUpdateManualActivity, UpdateActivityInput } from "./update";

// manual 活动账本资源面(账户级):只做装配(auth + 校验),schema 与实现同住各动作文件,
// 决策/物化在 ../manual/store。

export const createManualActivities = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .validator(CreateActivitiesInput)
  .handler(runEffect(handleCreateManualActivities));

export const removeManualActivity = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .validator(RemoveActivityInput)
  .handler(runEffect(handleRemoveManualActivity));

export const updateManualActivity = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .validator(UpdateActivityInput)
  .handler(runEffect(handleUpdateManualActivity));
