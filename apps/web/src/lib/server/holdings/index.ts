import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireAuth } from "../session/require-auth";
import { handleGetHoldingHistory } from "./history";

export const getHoldingHistory = createServerFn({ method: "GET" })
  .middleware([requireAuth])
  .validator(z.object({ key: z.string().min(1), since: z.number().int().nonnegative().optional() }))
  .handler(handleGetHoldingHistory);
