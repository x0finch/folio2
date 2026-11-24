import { createServerFn } from "@tanstack/react-start";
import { runEffect } from "@/lib/server/runtime";
import { requireAuth } from "@/lib/server/session/require-auth";
import { handleGetDataStats } from "./data-stats";
import { handleGetDataVersion } from "./data-version";
import { handleUpdatePrivacySettings, PrivacyInput } from "./privacy";
import { handleGetProviderKeyStatus } from "./provider-keys";
import {
  handleGetValuationSettings,
  handleUpdateValuationSettings,
  ValuationInput,
} from "./valuation";

// Not via `runEffect`: this only reads env, needing no services or userId.
export const getProviderKeyStatus = createServerFn({ method: "GET" })
  .middleware([requireAuth])
  .handler(handleGetProviderKeyStatus);

export const getDataStats = createServerFn({ method: "GET" })
  .middleware([requireAuth])
  .handler(runEffect(handleGetDataStats));

export const getDataVersion = createServerFn({ method: "GET" })
  .middleware([requireAuth])
  .handler(runEffect(handleGetDataVersion));

export const getValuationSettings = createServerFn({ method: "GET" })
  .middleware([requireAuth])
  .handler(runEffect(handleGetValuationSettings));

export const updateValuationSettings = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .validator(ValuationInput)
  .handler(runEffect(handleUpdateValuationSettings));

export const updatePrivacySettings = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .validator(PrivacyInput)
  .handler(runEffect(handleUpdatePrivacySettings));
