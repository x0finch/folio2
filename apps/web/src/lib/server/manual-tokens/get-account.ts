import { Effect } from "effect";
import { z } from "zod";
import { loadManualAccountDetail } from "@/lib/server/manual/store";

// 读:抽屉账户明细(token 定义 + 折叠 amount + 全部活动)。抽屉 useQuery,写后失效刷新。
export const GetManualAccountInput = z.object({ accountId: z.string().min(1) });

export const handleGetManualAccount = Effect.fn("getManualAccount")(function* (
  data: z.infer<typeof GetManualAccountInput>,
) {
  return yield* loadManualAccountDetail(data.accountId);
});
