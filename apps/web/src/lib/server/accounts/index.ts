import { createServerFn } from "@tanstack/react-start";
import { PortfolioSelectInput } from "@/lib/server/portfolio/scope";
import { runEffect } from "@/lib/server/runtime";
import { requireAuth } from "@/lib/server/session/require-auth";
import { CreateAccountInput, handleCreateAccount } from "./create";
import { handleReplaceAccountCredentials, ReplaceCredentialsInput } from "./credentials";
import { AccountHistoryInput, handleGetAccountHistory } from "./history";
import { handleListAccounts } from "./list";
import { handleRemoveAccount, RemoveAccountInput } from "./remove";
import { handleUpdateAccount, UpdateAccountInput } from "./update";

// accounts 资源面:只做装配(method / 鉴权 / 校验 / `runEffect`),实现与入参 schema 都在同目录的
// RESTful 文件里 —— 它们只描述业务、返回 Effect(#504 T8)。
// userId 经 requireAuth 的 withContext 自动带入(ALS);红线:不打 creds,只记安全字段。

// 账户列表按组合收口(ADR 0047)—— 缺省 = 默认组合。
export const listAccounts = createServerFn({ method: "GET" })
  .middleware([requireAuth])
  .validator(PortfolioSelectInput)
  .handler(runEffect(handleListAccounts));

export const createAccount = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .validator(CreateAccountInput)
  .handler(runEffect(handleCreateAccount));

export const replaceAccountCredentials = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .validator(ReplaceCredentialsInput)
  .handler(runEffect(handleReplaceAccountCredentials));

export const updateAccount = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .validator(UpdateAccountInput)
  .handler(runEffect(handleUpdateAccount));

export const removeAccount = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .validator(RemoveAccountInput)
  .handler(runEffect(handleRemoveAccount));

export const getAccountHistory = createServerFn({ method: "GET" })
  .middleware([requireAuth])
  .validator(AccountHistoryInput)
  .handler(runEffect(handleGetAccountHistory));
