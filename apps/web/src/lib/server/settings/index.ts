import { createServerFn } from "@tanstack/react-start";
import { runEffect } from "@/lib/server/runtime";
import { requireAuth } from "@/lib/server/session/require-auth";
import { handleGetDataStats } from "./data-stats";
import { handleGetProviderKeyStatus } from "./provider-keys";
import {
  handleGetValuationSettings,
  handleUpdateValuationSettings,
  ValuationInput,
} from "./valuation";

// **只有要服务的 handler 才经 `runEffect`。** `getProviderKeyStatus` 只读 env —— 一个服务都不要,
// 也没有 userId 可用;套一层装配等于为一次 `Boolean(env.X)` 建一遍 D1 句柄和整个参考层。
export const getProviderKeyStatus = createServerFn({ method: "GET" })
  .middleware([requireAuth])
  .handler(handleGetProviderKeyStatus);

export const getDataStats = createServerFn({ method: "GET" })
  .middleware([requireAuth])
  .handler(runEffect(handleGetDataStats));

export const getValuationSettings = createServerFn({ method: "GET" })
  .middleware([requireAuth])
  .handler(runEffect(handleGetValuationSettings));

export const updateValuationSettings = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .validator(ValuationInput)
  .handler(runEffect(handleUpdateValuationSettings));
