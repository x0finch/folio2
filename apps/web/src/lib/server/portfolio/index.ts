import { createServerFn } from "@tanstack/react-start";
import { runEffect } from "@/lib/server/runtime";
import { requireAuth } from "@/lib/server/session/require-auth";
import { handleGetFiatRefs } from "./fiat-refs";
import { handleGetPortfolioHistory, PortfolioHistoryInput } from "./get-history";
import { handleResolvePlatformMeta, PlatformMetaInput } from "./platform-meta";
import { PortfolioSelectInput } from "./scope";
import { handleGetSnapshots, SnapshotsInput } from "./snapshots";

// portfolio 资源面(读模型):只做装配,实现在同目录 RESTful 文件里(共享装配与入参 schema 在 ./scope)。

export const getSnapshots = createServerFn({ method: "GET" })
  .middleware([requireAuth])
  .validator(SnapshotsInput)
  .handler(runEffect(handleGetSnapshots));

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
  .handler(runEffect(handleGetPortfolioHistory));
