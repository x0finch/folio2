import { Effect } from "effect";
import { z } from "zod";
import { loadManualAccountDetail } from "@/lib/server/manual/store";

export const GetManualAccountInput = z.object({ accountId: z.string().min(1) });

export const handleGetManualAccount = Effect.fn("getManualAccount")(function* (
  data: z.infer<typeof GetManualAccountInput>,
) {
  return yield* loadManualAccountDetail(data.accountId);
});
