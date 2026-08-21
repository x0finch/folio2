import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireAuth } from "../session/require-auth";
import { handleGetDataStats } from "./data-stats";
import { handleGetProviderKeyStatus } from "./provider-keys";
import { handleGetValuationSettings, handleUpdateValuationSettings } from "./valuation";

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
  .validator(z.object({ mode: z.enum(["self-first", "source-first"]) }))
  .handler(handleUpdateValuationSettings);
