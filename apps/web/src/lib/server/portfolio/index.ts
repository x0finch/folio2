import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireAuth } from "../session/require-auth";
import { handleListAccountHoldings } from "./account-holdings";
import { handleGetAccountGain24h, handleGetPortfolioGain24h } from "./gain";
import { handleGetPortfolioHistory } from "./get-history";
import { handleGetPortfolioOverview } from "./overview";
import { handleGetHomeTabStrip } from "./tabs";

// portfolio 资源面(读模型):只做装配,实现在同目录 RESTful 文件里(共享装配在 ./scope)。

// 选中 Portfolio 入参:客户端选择器传的临时选中 id(可空 → 用默认)。缺省 {} 让 loader 不带参调用时退回默认视图。
// 仅按选中 Portfolio scope(曲线 / 列表默认口径);不带 pin。
const PortfolioSelectInput = z.object({ portfolioId: z.string().optional() }).default({});

// overview 入参:在选中 Portfolio 之上再叠一个自定义 Tab 的 pin(ADR 0034)—— 按 connector/tag/account
// 在选中 Portfolio 内再收窄;缺省 = 默认视图(不收窄)。pin 只收窄 overview 的列表,不进曲线(见 getPortfolioHistory)。
const TabPinScope = z
  .object({
    kind: z.enum(["connector", "tag", "account"]),
    connectorId: z.string().optional(),
    tagId: z.string().optional(),
    accountId: z.string().optional(),
  })
  .optional();
const PortfolioScopeInput = z
  .object({ portfolioId: z.string().optional(), pin: TabPinScope })
  .default({});

export const getPortfolioOverview = createServerFn({ method: "GET" })
  .middleware([requireAuth])
  .validator(PortfolioScopeInput)
  .handler(handleGetPortfolioOverview);

export const getPortfolioGain24h = createServerFn({ method: "GET" })
  .middleware([requireAuth])
  .validator(PortfolioScopeInput)
  .handler(handleGetPortfolioGain24h);

export const getHomeTabStrip = createServerFn({ method: "GET" })
  .middleware([requireAuth])
  .validator(PortfolioSelectInput)
  .handler(handleGetHomeTabStrip);

export const listAccountHoldings = createServerFn({ method: "GET" })
  .middleware([requireAuth])
  .handler(handleListAccountHoldings);

export const getAccountGain24h = createServerFn({ method: "GET" })
  .middleware([requireAuth])
  .handler(handleGetAccountGain24h);

export const getPortfolioHistory = createServerFn({ method: "GET" })
  .middleware([requireAuth])
  .validator(PortfolioSelectInput)
  .handler(handleGetPortfolioHistory);
