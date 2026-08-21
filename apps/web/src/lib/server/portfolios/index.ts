import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireAuth } from "../session/require-auth";
import { handleCreatePortfolio } from "./create";
import { handleDeletePortfolio } from "./delete";
import { handleListPortfolios } from "./list";
import { handleListPortfolioMemberships } from "./memberships";
import { handleMoveAccountToPortfolio } from "./move-account";
import { handleRenamePortfolio } from "./rename";
import { handleSetDefaultPortfolio } from "./set-default";

// portfolios 资源面:Portfolio 实体管理(选择器 + 抽屉「移到 Portfolio」用,ADR 0033)。
// 从 portfolio/(读模型资源)拆出 —— 13 个 fn 挤一个 index 本就是两个资源混住(#499)。

export const listPortfolios = createServerFn({ method: "GET" })
  .middleware([requireAuth])
  .handler(handleListPortfolios);

export const moveAccountToPortfolio = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .validator(
    z
      .object({
        accountId: z.string().min(1),
        portfolioId: z.string().min(1).optional(),
        newName: z.string().trim().min(1).optional(),
      })
      .refine((v) => v.portfolioId != null || v.newName != null, {
        message: "portfolioId or newName required",
      }),
  )
  .handler(handleMoveAccountToPortfolio);

export const createPortfolio = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .validator(z.object({ name: z.string().trim().min(1) }))
  .handler(handleCreatePortfolio);

export const listPortfolioMemberships = createServerFn({ method: "GET" })
  .middleware([requireAuth])
  .handler(handleListPortfolioMemberships);

const PortfolioIdInput = z.object({ portfolioId: z.string().min(1) });

export const renamePortfolio = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .validator(PortfolioIdInput.extend({ name: z.string().trim().min(1) }))
  .handler(handleRenamePortfolio);

export const setDefaultPortfolio = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .validator(PortfolioIdInput)
  .handler(handleSetDefaultPortfolio);

export const deletePortfolio = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .validator(PortfolioIdInput)
  .handler(handleDeletePortfolio);
