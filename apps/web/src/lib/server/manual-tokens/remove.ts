import { z } from "zod";
import { deleteToken } from "../manual/store";
import { runRequest } from "../oracle";
import type { AuthContext } from "../session/auth-session";

// 清空一个手记持仓:删该账户对这个币的全部活动。**代币行留着**(参考层数据,别的账户可能还在用)。
// accountId 必须带 —— #203 起一个币可以被多个手记账户持有,只给 tokenId 说不清清哪个账户的。
export const RemoveManualTokenInput = z.object({
  accountId: z.string().min(1),
  tokenId: z.string().min(1),
});

export async function handleRemoveManualToken({
  data,
  context,
}: {
  data: z.infer<typeof RemoveManualTokenInput>;
  context: AuthContext;
}) {
  await runRequest(context.userId, deleteToken(data.accountId, data.tokenId));
  return { ok: true as const };
}
