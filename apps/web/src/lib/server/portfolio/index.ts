import { createServerFn } from "@tanstack/react-start";
import { runEffect, runForUser } from "@/lib/server/runtime";
import { requireAuth } from "@/lib/server/session/require-auth";
import { handleListAccountHoldings } from "./account-holdings";
import { handleGetAccountGain24h, handleGetPortfolioGain24h } from "./gain";
import { handleGetPortfolioHistory } from "./get-history";
import { PortfolioScopeInput, PortfolioSelectInput } from "./scope";
import { handleGetPortfolioSnapshotData } from "./snapshot-data";
import { handleGetHomeTabStrip } from "./tabs";

// portfolio 资源面(读模型):只做装配,实现在同目录 RESTful 文件里(共享装配与入参 schema 在 ./scope)。

// 首页总览的原料接口(FOL-48):发一份当前快照原料,浏览器用 `buildOverview` 自己算总额 /
// 持仓 / 各小计 / pricesStale。**只取行 + 备料,不聚合** —— 所以走标准 `runEffect`,不需要
// 那条「读预计算 + waitUntil 补算」的路(总览不再有预计算读侧)。
export const getPortfolioSnapshotData = createServerFn({ method: "GET" })
  .middleware([requireAuth])
  .validator(PortfolioScopeInput)
  .handler(runEffect(handleGetPortfolioSnapshotData));

// **这两条读接口都不走 `runEffect`**(ADR 0049):它们只读预计算结果,缺 / 旧的时候要把补算
// 交给这次请求的 `waitUntil` —— 那是另起一次装配,要一个 userId,而 `runEffect` 刻意不把它
// 交给 handler。`runForUser` 是同一个内核,只是人由这里接(同 `syncAccount`)。
export const getPortfolioGain24h = createServerFn({ method: "GET" })
  .middleware([requireAuth])
  .validator(PortfolioScopeInput)
  .handler(({ data, context }) =>
    runForUser(context.userId, handleGetPortfolioGain24h(context.userId, data)),
  );

export const getHomeTabStrip = createServerFn({ method: "GET" })
  .middleware([requireAuth])
  .validator(PortfolioSelectInput)
  .handler(({ data, context }) =>
    runForUser(context.userId, handleGetHomeTabStrip(context.userId, data)),
  );

// 这两条也按组合收口(ADR 0047):账户页的持仓与盈亏只回当前组合那些账户。
export const listAccountHoldings = createServerFn({ method: "GET" })
  .middleware([requireAuth])
  .validator(PortfolioSelectInput)
  .handler(runEffect(handleListAccountHoldings));

export const getAccountGain24h = createServerFn({ method: "GET" })
  .middleware([requireAuth])
  .validator(PortfolioSelectInput)
  .handler(({ data, context }) =>
    runForUser(context.userId, handleGetAccountGain24h(context.userId, data)),
  );

export const getPortfolioHistory = createServerFn({ method: "GET" })
  .middleware([requireAuth])
  .validator(PortfolioSelectInput)
  .handler(runEffect(handleGetPortfolioHistory));
