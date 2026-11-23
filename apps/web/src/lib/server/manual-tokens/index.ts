import { createServerFn } from "@tanstack/react-start";
import { runEffect } from "@/lib/server/runtime";
import { requireAuth } from "@/lib/server/session/require-auth";
import { GetManualAccountInput, handleGetManualAccount } from "./get-account";
import { handleRemoveManualToken, RemoveManualTokenInput } from "./remove";

export const getManualAccount = createServerFn({ method: "GET" })
  .middleware([requireAuth])
  .validator(GetManualAccountInput)
  .handler(runEffect(handleGetManualAccount));

export const removeManualToken = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .validator(RemoveManualTokenInput)
  .handler(runEffect(handleRemoveManualToken));
