import { env } from "cloudflare:workers";
import { Database, NotFound } from "@folio/db";
import { getLogger } from "@logtape/logtape";
import { Effect } from "effect";
import { z } from "zod";
import { ConnectorRegistry } from "@/lib/server/connectors/registry";
import {
  carryOverCreds,
  openCreds,
  publicValues,
  readStoredCreds,
  SEMI_PREFIX,
  sealCreds,
} from "@/lib/server/creds";
import { serverFn } from "@/lib/server/server-fn";

// Log safe fields only, never creds.
const log = getLogger(["folio", "web", "accounts"]);

// Re-enter or change creds. Given fields replace stored ones after a liveness check; a public field
// not given keeps its value, a secret one too unless the connector says the change voids it; a
// blank optional field is cleared.
export const ReplaceCredentialsInput = z.object({
  accountId: z.string().min(1),
  creds: z.record(z.string(), z.string().trim()),
});

export const handleReplaceAccountCredentials = serverFn("replaceAccountCredentials")(function* (
  data: z.infer<typeof ReplaceCredentialsInput>,
) {
  const { accounts } = yield* Database;
  const connectors = yield* ConnectorRegistry;
  const account = yield* accounts.getById(data.accountId);
  // "Not yours" and "missing" share one error.
  if (!account) return yield* Effect.fail(new NotFound({ entity: "account", id: data.accountId }));
  const specs = connectors.specs[account.connectorId] ?? [];
  const raw = readStoredCreds(yield* accounts.getRawCreds(account.id)) ?? {};
  // A blank optional field clears it; a blank required one means "unchanged".
  const cleared = new Set(
    specs.filter((spec) => spec.optional && data.creds[spec.key] === "").map((spec) => spec.key),
  );
  const stored = Object.fromEntries(
    Object.entries(raw).filter(
      ([key]) => !cleared.has(key.startsWith(SEMI_PREFIX) ? key.slice(SEMI_PREFIX.length) : key),
    ),
  );
  const given = Object.fromEntries(Object.entries(data.creds).filter(([, v]) => v !== ""));
  const values = { ...publicValues(specs, stored), ...given };
  const keep = connectors.keepsSecrets(
    account.connectorId,
    publicValues(specs, stored),
    publicValues(specs, values),
  );
  // The shape gate and the probe judge the creds the account will end up with, so fields not
  // re-entered but kept are opened from storage for them; only `values` is sealed below.
  const kept = keep
    ? specs.filter((s) => s.type !== "public" && stored[s.key] != null && given[s.key] == null)
    : [];
  const keptPlain = yield* Effect.tryPromise({
    try: () => openCreds(kept, stored, env.SECRETS_KEY),
    catch: () => new Error("stored credentials can't be read; enter them all again"),
  });
  // Typed failure so the validation message reaches the form.
  yield* connectors.validate(
    account.connectorId,
    { ...keptPlain, ...values },
    { liveness: true, label: account.label },
  );
  const sealed = yield* Effect.promise(() => sealCreds(specs, values, env.SECRETS_KEY));
  yield* accounts.setCredentials(
    account.id,
    JSON.stringify(carryOverCreds(specs, stored, sealed, keep)),
  );
  log.info("credentials provided", { connectorId: account.connectorId, accountId: account.id });
  return { ok: true as const };
});
