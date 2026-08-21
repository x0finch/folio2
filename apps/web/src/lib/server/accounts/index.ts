import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireAuth } from "../session/require-auth";
import { handleCreateAccount } from "./create";
import { handleReplaceAccountCredentials } from "./credentials";
import { handleGetAccountHistory } from "./history";
import { handleListAccounts } from "./list";
import { handleRemoveAccount } from "./remove";
import { handleUpdateAccount } from "./update";

// accounts 资源面:只做装配(method / 鉴权 / 校验),实现在同目录的 RESTful 文件里。
// userId 经 requireAuth 的 withContext 自动带入(ALS);红线:不打 creds,只记安全字段。

export const listAccounts = createServerFn({ method: "GET" })
  .middleware([requireAuth])
  .handler(handleListAccounts);

// 表单原始输入 values(键 = connector.account.creds 的 key);trim 后落库。
// portfolioId:落在当前选中的 Portfolio(ADR 0033);缺省 → 服务端本就落默认 Portfolio。
export const createAccount = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .validator(
    z.object({
      connectorId: z.string().min(1),
      label: z.string().trim().min(1, "label is required"),
      values: z.record(z.string(), z.string().trim()),
      portfolioId: z.string().min(1).optional(),
    }),
  )
  .handler(handleCreateAccount);

export const replaceAccountCredentials = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .validator(
    z.object({
      accountId: z.string().min(1),
      creds: z.record(z.string(), z.string().trim()), // seal 原始输入 → 值先 trim
    }),
  )
  .handler(handleReplaceAccountCredentials);

const AccountIdInput = z.object({ accountId: z.string().min(1) });

export const updateAccount = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .validator(
    AccountIdInput.extend({
      label: z.string().trim().min(1, "label is required").optional(),
      archived: z.boolean().optional(),
    }),
  )
  .handler(handleUpdateAccount);

export const removeAccount = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .validator(AccountIdInput)
  .handler(handleRemoveAccount);

export const getAccountHistory = createServerFn({ method: "GET" })
  .middleware([requireAuth])
  .validator(
    z.object({
      accountId: z.string().min(1),
      since: z.number().int().nonnegative().optional(),
      connectorId: z.string().optional(),
    }),
  )
  .handler(handleGetAccountHistory);
