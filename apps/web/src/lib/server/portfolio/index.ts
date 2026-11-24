import { createServerFn } from "@tanstack/react-start";
import { runEffect, runEffectJson } from "@/lib/server/runtime";
import { requireAuth } from "@/lib/server/session/require-auth";
import { handleGetFiatRefs } from "./fiat-refs";
import { handleGetPortfolioHistory, PortfolioHistoryInput } from "./get-history";
import { handleResolvePlatformMeta, PlatformMetaInput } from "./platform-meta";
import { PortfolioSelectInput } from "./scope";
import { handleGetSnapshots, SnapshotsInput } from "./snapshots";

export const getSnapshots = createServerFn({ method: "GET" })
  .middleware([requireAuth])
  .validator(SnapshotsInput)
  .handler(runEffectJson(handleGetSnapshots));

export const getFiatRefs = createServerFn({ method: "GET" })
  .middleware([requireAuth])
  .validator(PortfolioSelectInput)
  .handler(runEffect(handleGetFiatRefs));

export const resolvePlatformMeta = createServerFn({ method: "GET" })
  .middleware([requireAuth])
  .validator(PlatformMetaInput)
  .handler(runEffect(handleResolvePlatformMeta));

export const getPortfolioHistory = createServerFn({ method: "GET" })
  .middleware([requireAuth])
  .validator(PortfolioHistoryInput)
  .handler(runEffectJson(handleGetPortfolioHistory));
