import { createServerFn } from "@tanstack/react-start";
import { PortfolioSelectInput } from "@/lib/server/portfolio/scope";
import { runEffect, runEffectJson } from "@/lib/server/runtime";
import { requireAuth } from "@/lib/server/session/require-auth";
import { ArchiveAccountInput, handleArchiveAccount } from "./archive";
import { CreateAccountInput, handleCreateAccountAndRefill } from "./create";
import { handleReplaceAccountCredentials, ReplaceCredentialsInput } from "./credentials";
import { AccountHistoryInput, handleGetAccountHistory } from "./history";
import { handleListAccounts } from "./list";
import { handleRemoveAccount, RemoveAccountInput } from "./remove";
import { handleRenameAccount, RenameAccountInput } from "./rename";

export const listAccounts = createServerFn({ method: "GET" })
  .middleware([requireAuth])
  .validator(PortfolioSelectInput)
  .handler(runEffectJson(handleListAccounts));

export const createAccount = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .validator(CreateAccountInput)
  .handler(runEffect(handleCreateAccountAndRefill));

export const replaceAccountCredentials = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .validator(ReplaceCredentialsInput)
  .handler(runEffect(handleReplaceAccountCredentials));

export const renameAccount = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .validator(RenameAccountInput)
  .handler(runEffect(handleRenameAccount));

export const archiveAccount = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .validator(ArchiveAccountInput)
  .handler(runEffect(handleArchiveAccount));

export const removeAccount = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .validator(RemoveAccountInput)
  .handler(runEffect(handleRemoveAccount));

export const getAccountHistory = createServerFn({ method: "GET" })
  .middleware([requireAuth])
  .validator(AccountHistoryInput)
  .handler(runEffectJson(handleGetAccountHistory));
