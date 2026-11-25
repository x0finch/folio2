import { z } from "zod";
import { loadManualAccountDetail } from "@/lib/server/manual/store";
import { serverFn } from "@/lib/server/server-fn";

export const GetManualAccountInput = z.object({ accountId: z.string().min(1) });

export const handleGetManualAccount = serverFn("getManualAccount")(function* (
  data: z.infer<typeof GetManualAccountInput>,
) {
  return yield* loadManualAccountDetail(data.accountId);
});
