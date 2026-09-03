import { Database } from "@folio/db";
import { Effect } from "effect";
import { z } from "zod";

// 隐私开关的写(FOL-75,ADR 0052)。读走 `getValuationSettings`(它其实读的是 user_settings
// 一整行 —— 估值口径 + 隐私标志同一份),这里只管翻 `hide_balances`。**刻意与估值写分开**:
// 估值口径驱动总览/走势的读时重估,privacy 是纯展示、不动任何计算,合在一起写会让翻隐私也
// 顺带触发一次总览重算。
export const PrivacyInput = z.object({ hideBalances: z.boolean() });

export const handleUpdatePrivacySettings = Effect.fn("updatePrivacySettings")(function* (
  data: z.infer<typeof PrivacyInput>,
) {
  yield* (yield* Database).settings.update({ hideBalances: data.hideBalances });
  return { ok: true };
});
