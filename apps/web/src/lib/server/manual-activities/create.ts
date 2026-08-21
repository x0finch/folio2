import { addManualActivities } from "../manual/store";
import { runRequest } from "../oracle";

// 批量新增(原子 + 整批拒;也承载"新建 token"流 —— 首条活动落 token)。
// draft 形状直接取自 ../manual/store 的入参 —— 决策/物化都在那层,这里不复述一份会漂移的类型。
export function handleCreateManualActivities({
  data,
  context,
}: {
  data: { accountId: string; drafts: Parameters<typeof addManualActivities>[1] };
  context: { userId: string };
}) {
  return runRequest(context.userId, addManualActivities(data.accountId, data.drafts));
}
