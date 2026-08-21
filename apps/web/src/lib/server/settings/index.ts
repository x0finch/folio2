import { createServerFn } from "@tanstack/react-start";
import { requireAuth } from "@/lib/server/session/require-auth";
import { handleGetDataStats } from "./data-stats";
import { handleGetProviderKeyStatus } from "./provider-keys";
import {
  handleGetValuationSettings,
  handleUpdateValuationSettings,
  ValuationInput,
} from "./valuation";

export const getProviderKeyStatus = createServerFn({ method: "GET" })
  .middleware([requireAuth])
  .handler(handleGetProviderKeyStatus);

export const getDataStats = createServerFn({ method: "GET" })
  .middleware([requireAuth])
  .handler(handleGetDataStats);

export const getValuationSettings = createServerFn({ method: "GET" })
  .middleware([requireAuth])
  .handler(handleGetValuationSettings);

export const updateValuationSettings = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .validator(ValuationInput)
  .handler(handleUpdateValuationSettings);
