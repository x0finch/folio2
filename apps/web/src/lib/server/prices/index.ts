import { createServerFn } from "@tanstack/react-start";
import { requireAuth } from "@/lib/server/session/require-auth";
import { handleRefreshStalePrices } from "./refresh-stale";

export const refreshStalePrices = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .handler(handleRefreshStalePrices);
