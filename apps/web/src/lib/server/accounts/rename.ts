import { Database } from "@folio/db";
import { getLogger } from "@logtape/logtape";
import { Effect } from "effect";
import { z } from "zod";

const log = getLogger(["folio", "web", "accounts"]);

// 重命名:纯 accounts 单资源写。db 层按 (id, userId) 作用域,天然杜绝越权;不存在则影响 0 行(静默),不额外抛。
export const RenameAccountInput = z.object({
  accountId: z.string().min(1),
  label: z.string().trim().min(1, "label is required"),
});

export const handleRenameAccount = Effect.fn("renameAccount")(function* (
  data: z.infer<typeof RenameAccountInput>,
) {
  yield* (yield* Database).accounts.rename(data.accountId, data.label);
  log.info("account renamed", { accountId: data.accountId });
  return { ok: true as const };
});
