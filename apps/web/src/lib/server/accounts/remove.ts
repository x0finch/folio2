import { AccountStore } from "@folio/db";
import { getLogger } from "@logtape/logtape";
import { z } from "zod";
import { runStore } from "../oracle";
import type { AuthContext } from "../session/auth-session";

const log = getLogger(["folio", "web", "accounts"]);

// 删除:不可逆(snapshots/manual_activity 经 ON DELETE CASCADE 级联清)。前端需二次确认。
// db 层按 (id, userId) 作用域,天然杜绝越权;不存在则影响 0 行(静默),不额外抛。
export const RemoveAccountInput = z.object({ accountId: z.string().min(1) });

export async function handleRemoveAccount({
  data,
  context,
}: {
  data: z.infer<typeof RemoveAccountInput>;
  context: AuthContext;
}) {
  await runStore(context.userId, AccountStore, (s) => s.remove(data.accountId));
  log.info("account deleted", { accountId: data.accountId });
  return { ok: true as const };
}
