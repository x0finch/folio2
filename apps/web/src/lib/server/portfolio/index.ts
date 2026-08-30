import { createServerFn } from "@tanstack/react-start";
import { runEffect } from "@/lib/server/runtime";
import { requireAuth } from "@/lib/server/session/require-auth";
import { handleListAccountHoldings } from "./account-holdings";
import { handleGetFiatRefs } from "./fiat-refs";
import { handleGetPortfolioHistory, PortfolioHistoryInput } from "./get-history";
import { handleResolvePlatformMeta, PlatformMetaInput } from "./platform-meta";
import { PortfolioScopeInput, PortfolioSelectInput } from "./scope";
import { handleGetPortfolioSnapshotData } from "./snapshot-data";
import { handleGetSnapshots, SnapshotsInput } from "./snapshots";

// portfolio 资源面(读模型):只做装配,实现在同目录 RESTful 文件里(共享装配与入参 schema 在 ./scope)。

// 首页总览的原料接口(FOL-48 / FOL-51):发当前 + 24 小时前两组快照原料,浏览器用 `buildOverview`
// 自己算总额 / 持仓 / 各小计 / 24h 盈亏 / pricesStale。**只取行 + 备料,不聚合** —— 所以走标准
// `runEffect`,不需要那条「读预计算 + waitUntil 补算」的路(盈亏预计算读侧已删,ADR 0050)。
export const getPortfolioSnapshotData = createServerFn({ method: "GET" })
  .middleware([requireAuth])
  .validator(PortfolioScopeInput)
  .handler(runEffect(handleGetPortfolioSnapshotData));

// 账户页持仓(含 24h 盈亏,两端相减现算)也按组合收口(ADR 0047):只回当前组合那些账户。
export const listAccountHoldings = createServerFn({ method: "GET" })
  .middleware([requireAuth])
  .validator(PortfolioSelectInput)
  .handler(runEffect(handleListAccountHoldings));

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
