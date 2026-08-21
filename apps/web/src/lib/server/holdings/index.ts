import { createServerFn } from "@tanstack/react-start";
import { requireAuth } from "../session/require-auth";
import { handleGetHoldingHistory, HoldingHistoryInput } from "./history";

export const getHoldingHistory = createServerFn({ method: "GET" })
  .middleware([requireAuth])
  .validator(HoldingHistoryInput)
  .handler(handleGetHoldingHistory);
