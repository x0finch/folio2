import { z } from "zod";
import { deleteToken } from "@/lib/server/manual/store";
import { serverFn } from "@/lib/server/server-fn";

// Removes the account's activities for the token; the shared `tokens` row stays. accountId is
// required since a token can be held by several manual accounts.
export const RemoveManualTokenInput = z.object({
  accountId: z.string().min(1),
  tokenId: z.string().min(1),
});

export const handleRemoveManualToken = serverFn("removeManualToken")(function* (
  data: z.infer<typeof RemoveManualTokenInput>,
) {
  yield* deleteToken(data.accountId, data.tokenId);
  return { ok: true as const };
});
