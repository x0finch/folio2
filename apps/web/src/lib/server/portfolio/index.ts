import { createServerFn } from "@tanstack/react-start";
import { runEffect } from "@/lib/server/runtime";
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

export const getPortfolioGain24h = createServerFn({ method: "GET" })
  .middleware([requireAuth])
  .validator(PortfolioScopeInput)
  .handler(runEffect(handleGetPortfolioGain24h));

export const getHomeTabStrip = createServerFn({ method: "GET" })
  .middleware([requireAuth])
  .validator(PortfolioSelectInput)
  .handler(runEffect(handleGetHomeTabStrip));

export const listAccountHoldings = createServerFn({ method: "GET" })
  .middleware([requireAuth])
  .handler(runEffect(handleListAccountHoldings));

export const getAccountGain24h = createServerFn({ method: "GET" })
  .middleware([requireAuth])
  .handler(runEffect(handleGetAccountGain24h));

export const getPortfolioHistory = createServerFn({ method: "GET" })
  .middleware([requireAuth])
  .validator(PortfolioSelectInput)
  .handler(runEffect(handleGetPortfolioHistory));
