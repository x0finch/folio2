import { Database, NotFound } from "@folio/db";
import { getLogger } from "@logtape/logtape";
import { Effect } from "effect";
import { z } from "zod";
import { ConnectorRegistry } from "@/lib/server/connectors/registry";
import { raw2sealed } from "./create";

// Log safe fields only, never creds.
const log = getLogger(["folio", "web", "accounts"]);

// Re-enter creds for imported accounts; the whole map is replaced after a liveness check.
export const ReplaceCredentialsInput = z.object({
  accountId: z.string().min(1),
  creds: z.record(z.string(), z.string().trim()),
});

export const handleReplaceAccountCredentials = Effect.fn("replaceAccountCredentials")(function* (
  data: z.infer<typeof ReplaceCredentialsInput>,
) {
  const { accounts } = yield* Database;
  const connectors = yield* ConnectorRegistry;
  const account = yield* accounts.getById(data.accountId);
  // "Not yours" and "missing" share one error.
  if (!account) return yield* Effect.fail(new NotFound({ entity: "account", id: data.accountId }));
  // Typed failure so the validation message reaches the form.
  yield* connectors.validate(account.connectorId, data.creds, {
    liveness: true,
    label: account.label,
  });
  const sealed = yield* Effect.promise(() =>
    raw2sealed(connectors.specs, account.connectorId, data.creds),
  );
  yield* accounts.setCredentials(account.id, sealed);
  log.info("credentials provided", { connectorId: account.connectorId, accountId: account.id });
  return { ok: true as const };
});
