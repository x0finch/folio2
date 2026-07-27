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

// 清空一个手记持仓:删该账户对这个币的全部活动。**代币行留着**(参考层数据,别的账户可能还在用)。
// accountId 必须带 —— #203 起一个币可以被多个手记账户持有,只给 tokenId 说不清清哪个账户的。
const RemoveTokenInput = z.object({
  accountId: z.string().min(1),
  tokenId: z.string().min(1),
});
export const removeManualToken = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .validator(RemoveTokenInput)
  .handler(async ({ data, context }) => {
    await deleteToken(context.userId, data.accountId, data.tokenId);
    return { ok: true as const };
  });
