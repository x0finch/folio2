import { Database } from "@folio/db";
import { getLogger } from "@logtape/logtape";
import { Effect } from "effect";
import { z } from "zod";
import { sealManualAccount } from "@/lib/server/manual/store";

const log = getLogger(["folio", "web", "accounts"]);

// Archiving seals a manual account: snapshot it from the ledger first, then set the flag.
// D1 has no cross-store transaction; this order's worst case is a harmless orphan snapshot,
// the reverse's is an archived account with nothing to show.
export const ArchiveAccountInput = z.object({
  accountId: z.string().min(1),
  archived: z.boolean(),
});

export const handleArchiveAccount = Effect.fn("archiveAccount")(function* (
  data: z.infer<typeof ArchiveAccountInput>,
) {
  const accounts = (yield* Database).accounts;
  let sealed = false;
  if (data.archived) {
    // Read before flagging: sealing only considers unarchived accounts.
    const account = yield* accounts.getById(data.accountId);
    // Skip already-archived accounts: re-flagging would move archivedAt without a new seal.
    if (account?.archivedAt == null) {
      if (account) sealed = yield* sealManualAccount(account);
      yield* accounts.setArchived(data.accountId, true);
      // Drop pins to it: they would still hold a slot and reappear on unarchive.
      // Unarchiving does not restore them.
      yield* (yield* Database).tabPins.removeByAccount(data.accountId);
    }
  } else {
    yield* accounts.setArchived(data.accountId, false);
  }
  log.info("account archived", {
    accountId: data.accountId,
    archived: data.archived,
    sealed,
  });
  return { ok: true as const };
});
