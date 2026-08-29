import { createServerFn } from "@tanstack/react-start";
import { runEffect, runForUser } from "@/lib/server/runtime";
import { requireAuth } from "@/lib/server/session/require-auth";
import { handleListAccountHoldings } from "./account-holdings";
import { handleGetAccountGain24h, handleGetPortfolioGain24h } from "./gain";
import { handleGetPortfolioHistory } from "./get-history";
import { handleGetPortfolioOverview } from "./overview";
import { PortfolioScopeInput, PortfolioSelectInput } from "./scope";
import { handleGetHomeTabStrip } from "./tabs";

// portfolio 资源面(读模型):只做装配,实现在同目录 RESTful 文件里(共享装配与入参 schema 在 ./scope)。

// **总览与 tab 条不走 `runEffect`**(ADR 0049):它们只读预计算结果,缺 / 旧的时候要把补算
// 交给这次请求的 `waitUntil` —— 那是另起一次装配,要一个 userId,而 `runEffect` 刻意不把它
// 交给 handler。`runForUser` 是同一个内核,只是人由这里接(同 `syncAccount`)。
export const getPortfolioOverview = createServerFn({ method: "GET" })
  .middleware([requireAuth])
  .validator(PortfolioScopeInput)
  .handler(({ data, context }) =>
    runForUser(context.userId, handleGetPortfolioOverview(context.userId, data)),
  );

// 24h 盈亏每次请求现算(ADR 0050:两个点查),不排补算 → 不需要 userId,标准装配即可。
export const getPortfolioGain24h = createServerFn({ method: "GET" })
  .middleware([requireAuth])
  .validator(PortfolioScopeInput)
  .handler(runEffect(handleGetPortfolioGain24h));

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
  .handler(runEffect(handleGetAccountGain24h));

export const getPortfolioHistory = createServerFn({ method: "GET" })
  .middleware([requireAuth])
  .validator(PortfolioSelectInput)
  .handler(runEffect(handleGetPortfolioHistory));
