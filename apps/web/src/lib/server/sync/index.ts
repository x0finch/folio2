import { createServerFn } from "@tanstack/react-start";
import { runEffect } from "@/lib/server/runtime";
import { requireAuth } from "@/lib/server/session/require-auth";
import { GetSyncRoundInput, handleGetSyncRound } from "./round";
import { handleSyncAccount, SyncAccountInput } from "./run";

// Doesn't sync inline: queues the account into a round and returns; the client polls the round.
export const syncAccount = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .validator(SyncAccountInput)
  .handler(runEffect(handleSyncAccount));

// Polled every 1.5s while busy; it is the only thing that changes.
export const getSyncRound = createServerFn({ method: "GET" })
  .middleware([requireAuth])
  .validator(GetSyncRoundInput)
  .handler(runEffect(handleGetSyncRound));
