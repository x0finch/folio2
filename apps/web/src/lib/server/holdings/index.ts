import { createServerFn } from "@tanstack/react-start";
import { requireAuth } from "@/lib/server/session/require-auth";
import { HoldingHistoryInput, handleGetHoldingHistory } from "./history";

export const getHoldingHistory = createServerFn({ method: "GET" })
  .middleware([requireAuth])
  .validator(HoldingHistoryInput)
  .handler(handleGetHoldingHistory);
