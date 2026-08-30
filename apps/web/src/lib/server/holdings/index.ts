import { createServerFn } from "@tanstack/react-start";
import { runEffect } from "@/lib/server/runtime";
import { requireAuth } from "@/lib/server/session/require-auth";
import { handleGetTokenValueHistory, TokenValueHistoryInput } from "./history";

export const getTokenValueHistory = createServerFn({ method: "GET" })
  .middleware([requireAuth])
  .validator(TokenValueHistoryInput)
  .handler(runEffect(handleGetTokenValueHistory));
