import type { Balance, ConnectorError, ProviderNeeds } from "@folio/connectors-basic";
import type { AccountRawCreds, AccountSafe, WriteSnapshotInput } from "@folio/db";
import { Context, type Effect, Layer, Logger, References } from "effect";
import type { SyncDepError } from "./errors";
import type { FetchOutcome, SyncLogger } from "./types";

// Methods take no userId: services are built per user by the assembler, so using the wrong user can't compile.
//
// The entry points still take userId, but only for log context: cron has no request-scoped context.

export class AccountStore extends Context.Service<
  AccountStore,
  {
    readonly list: () => Effect.Effect<readonly AccountSafe[], SyncDepError>;
    readonly rawCreds: () => Effect.Effect<readonly AccountRawCreds[], SyncDepError>;
  }
>()("sync/AccountStore") {}

export class BalanceSource extends Context.Service<
  BalanceSource,
  {
    readonly fetch: (
      account: AccountSafe,
      stored: Record<string, string>,
    ) => Effect.Effect<FetchOutcome, ConnectorError, ProviderNeeds>;
  }
>()("sync/BalanceSource") {}

export class SnapshotStore extends Context.Service<
  SnapshotStore,
  {
    readonly write: (
      accountId: string,
      input: WriteSnapshotInput,
    ) => Effect.Effect<string, SyncDepError>;
  }
>()("sync/SnapshotStore") {}

export class TokenOracle extends Context.Service<
  TokenOracle,
  {
    readonly mint: (
      balances: Balance[],
    ) => Effect.Effect<ReadonlyMap<string, string>, SyncDepError>;
    // null = not revalued; only then is totalUsd recomputed, else the provider's total is kept.
    readonly revalue: (
      connectorId: string,
      balances: Balance[],
      idByRef: ReadonlyMap<string, string>,
    ) => Effect.Effect<Balance[] | null, SyncDepError>;
  }
>()("sync/TokenOracle") {}

// All capabilities orchestration needs. `ProviderNeeds` (outbound HTTP) is declared, not provided, so tests can swap it.
export type SyncServices =
  | AccountStore
  | BalanceSource
  | SnapshotStore
  | TokenOracle
  | ProviderNeeds;

// Level threshold is All: filtering belongs to the injected logger, and Effect's default Info would eat `debug`.
// Test-only forwarder: lets cases assert which log, level and fields were emitted.
//
// Replaces every logger: don't combine it with a production logger, or each line is written twice.
export const syncLoggerLayer = (log: SyncLogger): Layer.Layer<never> =>
  Layer.merge(
    Logger.layer([
      Logger.make(({ fiber, logLevel, message }) => {
        const text = Array.isArray(message) ? message.map(String).join(" ") : String(message);
        const props = { ...fiber.getRef(References.CurrentLogAnnotations) };
        switch (logLevel) {
          case "Fatal":
          case "Error":
            return log.error(text, props);
          case "Warn":
            return log.warning(text, props);
          case "Debug":
          case "Trace":
            return log.debug(text, props);
          default:
            return log.info(text, props);
        }
      }),
    ]),
    Layer.succeed(References.MinimumLogLevel, "All"),
  );
