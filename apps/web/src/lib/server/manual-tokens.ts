import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { deleteToken, loadManualAccountDetail } from "./internal/manual";
import { requireAuth } from "./internal/require-auth";

// manual token 资源(账户级)。薄壳:auth(requireAuth 经 ALS 带 userId)+ 校验入参 + 调 ./manual 纯 async。
// 红线:只记安全字段,不打 creds(manual creds 全 public,但仍不入日志)。

// 读:抽屉账户明细(token 定义 + 折叠 amount + 全部活动)。抽屉 useQuery,写后失效刷新。
const AccountIdInput = z.object({ accountId: z.string().min(1) });
export const getManualAccount = createServerFn({ method: "GET" })
  .middleware([requireAuth])
  .validator(AccountIdInput)
  .handler(({ data, context }) => loadManualAccountDetail(context.userId, data.accountId));

// 删除一个 manual token(其活动经 ON DELETE CASCADE 一并清)。
const RemoveTokenInput = z.object({ tokenId: z.string().min(1) });
export const removeManualToken = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .validator(RemoveTokenInput)
  .handler(async ({ data, context }) => {
    await deleteToken(context.userId, data.tokenId);
    return { ok: true as const };
  });
