import { createServerFn } from "@tanstack/react-start";
import { requireAuth } from "@/lib/server/session/require-auth";
import { CreateAccountInput, handleCreateAccount } from "./create";
import { handleReplaceAccountCredentials, ReplaceCredentialsInput } from "./credentials";
import { AccountHistoryInput, handleGetAccountHistory } from "./history";
import { handleListAccounts } from "./list";
import { handleRemoveAccount, RemoveAccountInput } from "./remove";
import { handleUpdateAccount, UpdateAccountInput } from "./update";

// accounts 资源面:只做装配(method / 鉴权 / 校验),实现与入参 schema 都在同目录的 RESTful 文件里。
// userId 经 requireAuth 的 withContext 自动带入(ALS);红线:不打 creds,只记安全字段。

export const listAccounts = createServerFn({ method: "GET" })
  .middleware([requireAuth])
  .handler(handleListAccounts);

export const createAccount = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .validator(CreateAccountInput)
  .handler(handleCreateAccount);

export const replaceAccountCredentials = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .validator(ReplaceCredentialsInput)
  .handler(handleReplaceAccountCredentials);

export const updateAccount = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .validator(UpdateAccountInput)
  .handler(handleUpdateAccount);

export const removeAccount = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .validator(RemoveAccountInput)
  .handler(handleRemoveAccount);

export const getAccountHistory = createServerFn({ method: "GET" })
  .middleware([requireAuth])
  .validator(AccountHistoryInput)
  .handler(handleGetAccountHistory);
