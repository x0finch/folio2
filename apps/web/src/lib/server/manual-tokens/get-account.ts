import { loadManualAccountDetail } from "../manual/store";
import { runRequest } from "../oracle";

// 读:抽屉账户明细(token 定义 + 折叠 amount + 全部活动)。抽屉 useQuery,写后失效刷新。
export function handleGetManualAccount({
  data,
  context,
}: {
  data: { accountId: string };
  context: { userId: string };
}) {
  return runRequest(context.userId, loadManualAccountDetail(data.accountId));
}
