import { z } from "zod";
import { addManualActivities } from "../manual/store";
import { runRequest } from "../oracle";
import type { AuthContext } from "../session/auth-session";

export const ActivityKind = z.enum(["add", "reduce", "set"]);

const BatchDraftInput = z.object({
  token: z.object({
    symbol: z.string().trim().min(1),
    unitPrice: z.number().nonnegative(),
    // 选币下拉发的那张不透明票(#202b)。这一层只校验「是个非空串」—— 解票在 ../manual/store,
    // 解不开就当没选币。
    ticket: z.string().trim().min(1).nullish(),
  }),
  kind: ActivityKind,
  amount: z.number().nonnegative(),
  occurredAt: z.number().int(),
  price: z.number().nonnegative().nullish(),
  fee: z.number().nonnegative().nullish(),
  memo: z.string().trim().nullish(),
});

export const CreateActivitiesInput = z.object({
  accountId: z.string().min(1),
  drafts: z.array(BatchDraftInput).min(1),
});

// 批量新增(原子 + 整批拒;也承载"新建 token"流 —— 首条活动落 token)。
// draft 形状直接取自 ../manual/store 的入参 —— 决策/物化都在那层,这里不复述一份会漂移的类型。
export function handleCreateManualActivities({
  data,
  context,
}: {
  data: { accountId: string; drafts: Parameters<typeof addManualActivities>[1] };
  context: AuthContext;
}) {
  return runRequest(context.userId, addManualActivities(data.accountId, data.drafts));
}
