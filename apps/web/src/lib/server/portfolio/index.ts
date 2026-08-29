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

export const getPortfolioOverview = createServerFn({ method: "GET" })
  .middleware([requireAuth])
  .validator(PortfolioScopeInput)
  .handler(runEffect(handleGetPortfolioOverview));

// **这两条不走 `runEffect`**(ADR 0049):它们只读预计算结果,缺 / 旧的时候要把补算交给这次
// 请求的 `waitUntil` —— 那是另起一次装配,要一个 userId,而 `runEffect` 刻意不把它交给 handler。
// `runForUser` 是同一个内核,只是人由这里接(同 `syncAccount`)。
export const getPortfolioGain24h = createServerFn({ method: "GET" })
  .middleware([requireAuth])
  .validator(PortfolioScopeInput)
  .handler(({ data, context }) =>
    runForUser(context.userId, handleGetPortfolioGain24h(context.userId, data)),
  );

export const getHomeTabStrip = createServerFn({ method: "GET" })
  .middleware([requireAuth])
  .validator(PortfolioSelectInput)
  .handler(runEffect(handleGetHomeTabStrip));

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
