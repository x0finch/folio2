import { createServerFn } from "@tanstack/react-start";
import { runEffect } from "@/lib/server/runtime";
import { requireAuth } from "@/lib/server/session/require-auth";
import { CreateActivitiesInput, handleCreateManualActivitiesAndRefill } from "./create";
import { handleRemoveManualActivity, RemoveActivityInput } from "./remove";
import { handleUpdateManualActivityAndRefill, UpdateActivityInput } from "./update";

export const createManualActivities = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .validator(CreateActivitiesInput)
  .handler(runEffect(handleCreateManualActivitiesAndRefill));

export const removeManualActivity = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .validator(RemoveActivityInput)
  .handler(runEffect(handleRemoveManualActivity));

export const updateManualActivity = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .validator(UpdateActivityInput)
  .handler(runEffect(handleUpdateManualActivityAndRefill));
