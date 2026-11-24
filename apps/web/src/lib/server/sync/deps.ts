import { env } from "cloudflare:workers";
import { FolioHttpClient } from "@folio/client-core";
import {
  type ConnectorManifest,
  registry as connectorRegistry,
  getConnector,
  selectProvider,
  validateCredentials,
} from "@folio/connectors";
import {
  type Balance,
  type ConnectorError,
  ConnectorFailure,
  fromProviderError,
  type ProviderNeeds,
} from "@folio/connectors-basic";
import { type AccountSafe, Database, type DbRequest, type WriteSnapshotInput } from "@folio/db";
import { Oracle, type OracleServices } from "@folio/oracle";
import type { ValuationMode } from "@folio/oracle-basic";
import {
  BalanceSource,
  depError,
  type FetchOutcome,
  AccountStore as SyncAccountStore,
  type SyncDepError,
  type SyncServices,
  SnapshotStore as SyncSnapshotStore,
  TokenOracle,
} from "@folio/sync";
import { Context, Effect, Layer } from "effect";
import type { InputSpec } from "@/lib/server/creds";
import { isComplete, openCreds } from "@/lib/server/creds";
import { revalue } from "./revalue";
import { isSyncableAccount } from "./status";

// Server-only (imports cloudflare:workers): reached from server fn handlers, which the client
// bundle strips, and from the cron.
// Stays an Effect end to end: a Promise hop would cut the sync timeout/interrupt off from the
// provider. Decrypt / validate failures map to non-retryable.
const fetchViaConnector = (
  cid: string,
  manifest: ConnectorManifest,
  account: AccountSafe,
  stored: Record<string, string>,
  seeds: SeedCollector,
): Effect.Effect<FetchOutcome, ConnectorError, ProviderNeeds> =>
  Effect.gen(function* () {
    const specs = manifest.account.creds as unknown as InputSpec[]; // same {key,type} shape
    if (!isComplete(specs, stored)) return { status: "needs-credentials" } satisfies FetchOutcome;
    const plain = yield* Effect.tryPromise({
      try: () => openCreds(specs, stored, env.SECRETS_KEY),
      catch: fromProviderError,
    });
    // Validate again before fetching: a malformed identifier fails fast as non-retryable instead of
    // hitting the upstream for a 4xx and retrying.
    const validated = yield* Effect.tryPromise({
      try: () => validateCredentials(manifest.account.creds, plain),
      catch: fromProviderError,
    });
    const provider = selectProvider(manifest);
    if (!provider) {
      return yield* new ConnectorFailure({ message: `no provider for connector ${cid}` });
    }
    // Inject only the global keys the provider declares (least privilege).
    const providerCreds: Record<string, string> = {};
    for (const f of provider.creds) {
      const v = (env as unknown as Record<string, string | undefined>)[f.key];
      if (v != null) providerCreds[f.key] = v;
    }
    const ctx = {
      account: { id: account.id, label: account.label, connectorId: cid, creds: validated },
      creds: providerCreds,
    };
    // No cast: it would hide a change to the `fetchBalances` contract from the compiler.
    const { balances: rows, note } = yield* provider.fetchBalances(ctx);
    const totalUsd = rows.reduce((sum, b) => sum + b.value, 0);
    seeds.collect(rows);
    return { status: "ok", balances: rows, totalUsd, note } satisfies FetchOutcome;
  });

// Snapshots don't keep provider name/logo, but mint needs them for new tokens. Collect them when
// balances are fetched; lives for one sync round.
interface SeedCollector {
  collect(rows: readonly Balance[]): void;
  of(tokenRef: string, symbol: string): { symbol: string; name?: string; providerLogo?: string };
}

function createSeedCollector(): SeedCollector {
  const bySeed = new Map<string, { symbol: string; name?: string; providerLogo?: string }>();
  return {
    collect(rows: readonly Balance[]): void {
      for (const b of rows) {
        if (!b.tokenRef || bySeed.has(b.tokenRef)) continue;
        bySeed.set(b.tokenRef, {
          // Upper-case is the store's key convention.
          symbol: b.symbol.trim().toUpperCase(),
          name: b.name,
          providerLogo: b.logo,
        });
      }
    },
    // Fetch always precedes write within a round; fall back to the symbol alone.
    of(tokenRef: string, symbol: string) {
      return bySeed.get(tokenRef) ?? { symbol: symbol.trim().toUpperCase() };
    },
  };
}

// One build = one user's sync round; userId comes from the surrounding `forUser` / `runForUser`.
// DB and oracle fail with defects, but the sync orchestration isolates only typed failures, so
// defects are translated to `SyncDepError` explicitly.
const asDep =
  (step: Parameters<typeof depError>[0]) =>
  <A, E>(effect: Effect.Effect<A, E>): Effect.Effect<A, E | SyncDepError> =>
    effect.pipe(Effect.catchDefect((cause) => Effect.fail(depError(step, cause))));

/** `only`: restrict the round to these accounts (the queue consumer's single account). */
interface SyncScope {
  only: ReadonlySet<string>;
}

/**
 * Built as a Context, not a Layer: merging five layers cost several ms per `sync-account` message,
 * a big share of a 10ms budget. `makeSyncServicesLayer` wraps the same wiring.
 */
export const makeSyncServices = (
  scope?: SyncScope,
): Effect.Effect<
  Context.Context<SyncServices>,
  never,
  // Captured at build time so the `@folio/sync` services keep `R = never`.
  Database | OracleServices | DbRequest
> =>
  Effect.gen(function* () {
    const seeds = createSeedCollector();
    const { accounts, snapshots, settings } = yield* Database;
    // Capture this round's DB request; ops read it at run time and the services expose `R = never`.
    const request = yield* Effect.context<DbRequest>();
    // Capture oracle services so they don't leak into this service's `R`.
    const oracle = yield* Effect.context<OracleServices | DbRequest>();
    const http = yield* Effect.provide(Effect.context<ProviderNeeds>(), FolioHttpClient);
    const only = scope?.only ?? null;
    // Read once per round, lazily: on-chain-only rounds never revalue.
    let mode: ValuationMode | undefined;
    const modeOnce = Effect.suspend(() =>
      mode !== undefined
        ? Effect.succeed(mode)
        : Effect.map(settings.get().pipe(Effect.provide(request)), (row) => {
            mode = row.valuationMode;
            return row.valuationMode;
          }),
    );
    return Context.make(SyncAccountStore, {
      // Archived and manual accounts are not sync sources.
      list: () =>
        Effect.map(accounts.list(), (rows) =>
          rows.filter(isSyncableAccount).filter((a) => only == null || only.has(a.id)),
        ).pipe(Effect.provide(request), asDep("listAccounts")),
      rawCreds: () => accounts.listRawCreds().pipe(Effect.provide(request), asDep("listRawCreds")),
    }).pipe(
      Context.add(SyncSnapshotStore, {
        // Same-hour snapshots collapse: charts only plot each hour's last point. Imports keep the
        // default (append) since they restore history. `orDie`: the accountId comes from the
        // user's own list, so NotFound here is a bug; `asDep` turns it into a `SyncDepError`.
        write: (accountId: string, input: WriteSnapshotInput) =>
          snapshots
            .write(accountId, input, { collapseSameHour: true })
            .pipe(Effect.provide(request), Effect.orDie, asDep("writeSnapshot")),
      }),
      Context.add(BalanceSource, {
        // A missing manifest is a data error, isolated per account.
        fetch: (account, stored) => {
          const cid = account.connectorId;
          const manifest = getConnector(connectorRegistry, cid);
          if (!manifest) {
            return Effect.fail(
              new ConnectorFailure({ message: `no connector for connectorId ${cid}` }),
            );
          }
          // Per-user upstream concurrency is capped by the runner (one job at a time).
          return fetchViaConnector(cid, manifest, account, stored, seeds);
        },
      }),
      Context.add(TokenOracle, {
        // Upstream failures stay typed `SyncDepError` so mint / revalue degrade best-effort instead
        // of losing the whole account to a defect.
        mint: (rows) => {
          const refs = rows.flatMap((b) =>
            b.tokenRef ? [{ ref: b.tokenRef, seed: seeds.of(b.tokenRef, b.symbol) }] : [],
          );
          if (refs.length === 0) {
            return Effect.succeed(new Map<string, string>() as ReadonlyMap<string, string>);
          }
          return Effect.flatMap(Oracle, (o) => o.tokens.mint(refs)).pipe(
            Effect.provide(oracle),
            Effect.mapError((e) => depError("mint", e)),
            asDep("mint"),
          );
        },
        // Mark-to-market comes from the connector manifest's `valuation`.
        revalue: (connectorId, rows, idByRef) =>
          Effect.flatMap(modeOnce, (valuation) =>
            revalue(
              getConnector(connectorRegistry, connectorId)?.valuation === "mark-to-market",
              rows,
              idByRef,
              valuation,
            ),
          ).pipe(
            Effect.provide(oracle),
            Effect.mapError((e) => depError("revalue", e)),
            asDep("revalue"),
          ),
      }),
      Context.merge(http),
    );
  });

export const makeSyncServicesLayer = (
  scope?: SyncScope,
): Layer.Layer<SyncServices, never, Database | OracleServices | DbRequest> =>
  Layer.effectContext(makeSyncServices(scope));
