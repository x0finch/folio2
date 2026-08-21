import { z } from "zod";
import { loadManualAccountDetail } from "@/lib/server/manual/store";
import { runRequest } from "@/lib/server/oracle";
import type { AuthContext } from "@/lib/server/session/auth-session";

// 读:抽屉账户明细(token 定义 + 折叠 amount + 全部活动)。抽屉 useQuery,写后失效刷新。
export const GetManualAccountInput = z.object({ accountId: z.string().min(1) });

export function handleGetManualAccount({
  data,
  context,
}: {
  data: z.infer<typeof GetManualAccountInput>;
  context: AuthContext;
}) {
  return runRequest(context.userId, loadManualAccountDetail(data.accountId));
}
