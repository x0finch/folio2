import { createServerFn } from "@tanstack/react-start";
import { runEffect } from "@/lib/server/runtime";
import { requireAuth } from "@/lib/server/session/require-auth";
import { CreatePortfolioInput, handleCreatePortfolio } from "./create";
import { DeletePortfolioInput, handleDeletePortfolio } from "./delete";
import { handleListPortfolios } from "./list";
import { handleMoveAccountToPortfolio, MoveAccountInput } from "./move-account";
import { handleRenamePortfolio, RenamePortfolioInput } from "./rename";
import { handleSetDefaultPortfolio, SetDefaultPortfolioInput } from "./set-default";

export const listPortfolios = createServerFn({ method: "GET" })
  .middleware([requireAuth])
  .handler(runEffect(handleListPortfolios));

export const moveAccountToPortfolio = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .validator(MoveAccountInput)
  .handler(runEffect(handleMoveAccountToPortfolio));

export const createPortfolio = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .validator(CreatePortfolioInput)
  .handler(runEffect(handleCreatePortfolio));

export const renamePortfolio = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .validator(RenamePortfolioInput)
  .handler(runEffect(handleRenamePortfolio));

export const setDefaultPortfolio = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .validator(SetDefaultPortfolioInput)
  .handler(runEffect(handleSetDefaultPortfolio));

export const deletePortfolio = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .validator(DeletePortfolioInput)
  .handler(runEffect(handleDeletePortfolio));
