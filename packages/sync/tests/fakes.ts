import { FolioHttpClient } from "@folio/client-core";
import type { AccountRawCreds, AccountSafe, WriteSnapshotInput } from "@folio/db";
import { Effect, Layer, Logger } from "effect";
import { depError } from "../src/errors";
import {
  AccountStore,
  BalanceSource,
  SnapshotStore,
  type SyncServices,
  syncLoggerLayer,
  TokenOracle,
} from "../src/services";
import type { FetchOutcome, SyncLogger } from "../src/types";

// Defaults are the most boring case: no accounts, no creds, empty successful fetch, no revalue.

export interface FakeOptions {
  accounts?: readonly AccountSafe[] | (() => Promise<readonly AccountSafe[]>);
  rawCreds?: readonly AccountRawCreds[];
  fetch?: BalanceSource["Service"]["fetch"];
  mint?: TokenOracle["Service"]["mint"];
  revalue?: TokenOracle["Service"]["revalue"];
  log?: SyncLogger;
}

export interface Fakes {
  layer: Layer.Layer<SyncServices>;
  writes: Array<{ accountId: string; input: WriteSnapshotInput }>;
}

const okEmpty: FetchOutcome = { status: "ok", balances: [], totalUsd: 0 };

export const fakeServices = (options: FakeOptions = {}): Fakes => {
  const writes: Fakes["writes"] = [];
  const accounts = options.accounts ?? [];
  const layer = Layer.mergeAll(
    FolioHttpClient,
    // Silent logger by default, so Effect's console logger stays out of test output.
    options.log ? syncLoggerLayer(options.log) : Logger.layer([]),
    Layer.succeed(AccountStore, {
      // Failures must map to `SyncDepError`, not defects: `Sweep.userTally` catchAll only handles typed failures.
      list: () =>
        typeof accounts === "function"
          ? Effect.tryPromise({ try: accounts, catch: (e) => depError("listAccounts", e) })
          : Effect.succeed(accounts),
      rawCreds: () => Effect.succeed(options.rawCreds ?? []),
    }),
    Layer.succeed(SnapshotStore, {
      write: (accountId, input) =>
        Effect.sync(() => {
          writes.push({ accountId, input });
          return `snap-${accountId}`;
        }),
    }),
    Layer.succeed(BalanceSource, { fetch: options.fetch ?? (() => Effect.succeed(okEmpty)) }),
    Layer.succeed(TokenOracle, {
      mint: options.mint ?? (() => Effect.succeed(new Map<string, string>())),
      revalue: options.revalue ?? (() => Effect.succeed(null)),
    }),
  );
  return { layer, writes };
};
