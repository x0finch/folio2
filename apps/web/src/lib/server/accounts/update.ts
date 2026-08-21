import { AccountStore } from "@folio/db";
import { getLogger } from "@logtape/logtape";
import { Effect } from "effect";
import { z } from "zod";
import { sealManualAccount } from "@/lib/server/manual/store";
import { runRequest } from "@/lib/server/oracle";
import type { AuthContext } from "@/lib/server/session/auth-session";

const log = getLogger(["folio", "web", "accounts"]);

// 部分更新:重命名 和/或 归档切换(按传入字段各自生效)。归档可逆、数据保留;归档后不计总额、不参与同步。
// db 层按 (id, userId) 作用域,天然杜绝越权;不存在则影响 0 行(静默),不额外抛。
//
// **归档 = 封存(ADR 0039),对 manual 账户它是一次写。** manual 从不写快照(ADR 0018),归档之后
// 库里没有任何可展示的照片 —— 所以先按账本算一次、落一张真快照,**成功了才**打归档标记。
//
// **顺序不可颠倒,这不是风格问题:**
//   · D1 没有交互式事务,而这两条写分属快照与账户两个 store,没有共同的 batch 边界;
//   · 按这个顺序,最坏情况是留下一张孤儿快照 —— 无害,只是账户历史里多一个真实数据点,
//     而且下次归档成功会再写一张更新的;
//   · 反过来,最坏情况是「已归档但没有照片」—— 正好是这次要消灭的那个状态。
// 为此**不**在 `@folio/db` 里开跨两张表的合并 op:为一个低频动作在契约层捅个口子,不划算。
//
// 封存那一步要用参考层(取现价),所以整段从 `runStore` 换成 `runRequest`。
export const UpdateAccountInput = z.object({
  accountId: z.string().min(1),
  label: z.string().trim().min(1, "label is required").optional(),
  archived: z.boolean().optional(),
});

export async function handleUpdateAccount({
  data,
  context,
}: {
  data: z.infer<typeof UpdateAccountInput>;
  context: AuthContext;
}) {
  const sealed = await runRequest(
    context.userId,
    Effect.gen(function* () {
      const accounts = yield* AccountStore;
      if (data.label !== undefined) yield* accounts.rename(data.accountId, data.label);
      let sealed = false;
      if (data.archived === true) {
        // 取的是**还没打标记**的那一行 —— 封存那条路按「未归档」过滤,顺序反了会一无所获。
        const account = yield* accounts.getById(data.accountId);
        // **已经归档的不再动它**(review 补):对已归档账户再发一次 `archived: true`,封存那步会
        // 被「未归档」这道过滤挡掉、什么都不落,而 `setArchived` 却会把 `archivedAt` 重写成当刻 ——
        // 结果是封存时刻往前跳、数据还停在旧那张:曲线的截断点、抽屉曲线的窗口锚都跟着挪,
        // 而它们描述的那份数据一点没变。UI 那颗按钮是切换、触发不到这条,但 server fn 收得下。
        if (account?.archivedAt == null) {
          if (account) sealed = yield* sealManualAccount(account);
          yield* accounts.setArchived(data.accountId, true);
        }
      } else if (data.archived === false) {
        yield* accounts.setArchived(data.accountId, false);
      }
      return sealed;
    }),
  );
  log.info("account updated", {
    accountId: data.accountId,
    renamed: data.label !== undefined,
    archived: data.archived,
    sealed,
  });
  return { ok: true as const };
}
