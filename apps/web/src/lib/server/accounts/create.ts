import { env } from "cloudflare:workers";
import type { ConnectorId } from "@folio/connectors";
import { type AccountSafe, Database, type DbRequest } from "@folio/db";
import type { Oracle } from "@folio/oracle";
import { getLogger } from "@logtape/logtape";
import { Effect } from "effect";
import { z } from "zod";
import { isManual } from "@/lib/core/manual";
import { ConnectorRegistry } from "@/lib/server/connectors/registry";
import { sealCreds } from "@/lib/server/creds";
import { createManualAccount } from "@/lib/server/manual/store";
import { refillDailyPrices } from "@/lib/server/prices/daily";

const log = getLogger(["folio", "web", "accounts"]);

// Seals per field type: only `secret` fields are encrypted. SECRETS_KEY stays in the app layer.
export const raw2sealed = async (
  specs: ConnectorRegistry["specs"],
  connectorId: ConnectorId,
  values: Record<string, string>,
) => JSON.stringify(await sealCreds(specs[connectorId] ?? [], values, env.SECRETS_KEY));

export const createAccountFor = (
  connectorId: ConnectorId,
  label: string,
  rawValues: Record<string, string>,
): Effect.Effect<AccountSafe, Error, ConnectorRegistry | Database | Oracle | DbRequest> =>
  Effect.gen(function* () {
    const connectors = yield* ConnectorRegistry;
    // Blank optional fields become absent; blank required ones fail validation.
    const values = Object.fromEntries(Object.entries(rawValues).filter(([, v]) => v !== ""));
    // Typed failure, not a defect: the message must reach the form intact.
    yield* connectors.validate(connectorId, values, { liveness: true, label });

    const account = yield* isManual(connectorId)
      ? createManualAccount(label, values.tokens)
      : Effect.gen(function* () {
          const creds = yield* Effect.promise(() =>
            raw2sealed(connectors.specs, connectorId, values),
          );
          return yield* (yield* Database).accounts.create({ connectorId, label, creds });
        });
    log.info("account created", { connectorId, accountId: account.id });
    return account;
  });

// Without portfolioId the account stays in the default portfolio.
export const CreateAccountInput = z.object({
  connectorId: z.string().min(1),
  label: z.string().trim().min(1, "label is required"),
  values: z.record(z.string(), z.string().trim()),
  portfolioId: z.string().min(1).optional(),
});

export const handleCreateAccount = Effect.fn("createAccount")(function* (
  data: z.infer<typeof CreateAccountInput>,
) {
  const account = yield* createAccountFor(data.connectorId as ConnectorId, data.label, data.values);
  const portfolioId = data.portfolioId;
  if (portfolioId) {
    yield* (yield* Database).portfolios.assignAccount(account.id, portfolioId);
  }
  return account;
});

// Manual accounts get a targeted daily-prices refill so the first token's history needn't wait
// for the next hourly run.
export const handleCreateAccountAndRefill = Effect.fn("createAccount")(function* (
  data: z.infer<typeof CreateAccountInput>,
) {
  const account = yield* handleCreateAccount(data);
  if (isManual(account.connectorId)) yield* refillDailyPrices(account.id);
  return account;
});
