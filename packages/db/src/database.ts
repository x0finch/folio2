import { Context, Effect } from "effect";
import { DbClient } from "./client";
import { CurrentUser } from "./current-user";
import { makeAccountStore, makeGlobalAccountStore } from "./domains/accounts";
import { makeUserCacheStore } from "./domains/cache";
import { makeDataVersionStore } from "./domains/data-version";
import { makeGlobalRefIndexStore } from "./domains/global-ref-index";
import { makeManualStore } from "./domains/manual";
import { makePortfolioStore } from "./domains/portfolios";
import { makeSettingsStore } from "./domains/settings";
import { makeSnapshotStore } from "./domains/snapshots";
import { makeSyncRoundStore } from "./domains/sync-rounds";
import { makeTabPinStore } from "./domains/tab-pins";
import { makeTagStore } from "./domains/tags";
import { makeUserTokenPriceStore } from "./domains/token-prices";
import { makeUserTokenStore } from "./domains/tokens";
import { makeTransferStore } from "./domains/transfer";

/** The per-request pair: who (`CurrentUser`) and the D1 handle (`DbClient`), supplied only by the assembly point via the provide* combinators. */
export type DbRequest = CurrentUser | DbClient;

type EffectMethod = (...args: never[]) => Effect.Effect<unknown, unknown, unknown>;
type Methods = Record<string, EffectMethod>;

type PerCall<S, R> = {
  [K in keyof S]: S[K] extends (...args: infer P) => Effect.Effect<infer A, infer E, infer R0>
    ? (...args: P) => Effect.Effect<A, E, R0 | R>
    : never;
};

/**
 * The only place that reads `CurrentUser` / `DbClient`. Each ticket method binds both at call time from the fiber context,
 * so the ticket itself is request-free and built once per isolate. Binding is a few closures, so no caching.
 * Method names come from binding a placeholder once; domain functions must not touch the connection at top level.
 * Spans: key + method gives `accounts.create`, with `captureStackTrace: false` because the call site is always this line.
 */
const bindPerCall =
  <Args extends readonly unknown[], R>(read: Effect.Effect<Args, never, R>, placeholder: Args) =>
  <D extends Record<string, (...args: Args) => Methods>>(
    domains: D,
  ): { [K in keyof D]: PerCall<ReturnType<D[K]>, R> } =>
    Object.fromEntries(
      Object.entries(domains).map(([domain, bind]) => [
        domain,
        Object.fromEntries(
          Object.keys(bind(...placeholder)).map((method) => [
            method,
            (...args: never[]) =>
              Effect.flatMap(read, (ctx) => bind(...ctx)[method](...args)).pipe(
                Effect.withSpan(`${domain}.${method}`, { captureStackTrace: false }),
              ),
          ]),
        ),
      ]),
    ) as { [K in keyof D]: PerCall<ReturnType<D[K]>, R> };

const unbound = DbClient.make({
  query: () => Effect.die(new Error("db: an op ran against the placeholder client")),
  batch: () => Effect.die(new Error("db: an op ran against the placeholder client")),
});

const perUser = bindPerCall(
  Effect.contextWith(
    (ctx: Context.Context<DbRequest>) =>
      [Context.get(ctx, DbClient), Context.get(ctx, CurrentUser)] as const,
  ),
  [unbound, ""] as const,
);

// No `CurrentUser` in `R`: only the connection is taken.
const ownerless = bindPerCall(
  Effect.map(DbClient, (client) => [client] as const),
  [unbound] as const,
);

const databaseOps = () =>
  perUser({
    accounts: makeAccountStore,
    // Read-only; the triggers bump it (see `domains/data-version.ts`).
    dataVersion: makeDataVersionStore,
    manual: makeManualStore,
    portfolios: makePortfolioStore,
    settings: makeSettingsStore,
    snapshots: makeSnapshotStore,
    // Lives on `user_cache` but isn't a KV use: its writes are single statements conditional on the round id, which `put(key, value)` can't express.
    syncRounds: makeSyncRoundStore,
    tabPins: makeTabPinStore,
    tags: makeTagStore,
    transfer: makeTransferStore,
    // Per-user KV cache: a storage slice, not a domain, used directly by the app (DeFi protocol graph) with no upstream.
    cache: makeUserCacheStore,
  });

export class Database extends Effect.Service<Database>()("db/Database", { sync: databaseOps }) {}

// `R` has `DbClient` but no `CurrentUser`: this ticket can't reach user data.
const globalOps = () =>
  ownerless({
    refIndex: makeGlobalRefIndexStore,
    accounts: makeGlobalAccountStore,
  });

export class GlobalDatabase extends Effect.Service<GlobalDatabase>()("db/GlobalDatabase", {
  sync: globalOps,
}) {}

/** The two tickets built as a plain context, skipping Layer machinery (~20ms CPU on a cold isolate) for cron / queue entry points. */
export const databaseTickets = (): Context.Context<Database | GlobalDatabase> =>
  Context.make(Database, Database.make(databaseOps())).pipe(
    Context.add(GlobalDatabase, GlobalDatabase.make(globalOps())),
  );

// Not part of `Database`: tokens / tokenPrices there would let any handler edit token and price rows, bypassing mint and SWR orchestration.
//
// `namer` is a parameter, not yielded from a service, so db never consumes an oracle service and stays vendor-free.
//
// `cache` also exists on `Database`; the store is stateless, so both read and write the same table.
export class DatabaseForOracle extends Effect.Service<DatabaseForOracle>()("db/DatabaseForOracle", {
  effect: (namer: string) =>
    Effect.sync(() =>
      perUser({
        tokens: makeUserTokenStore(namer),
        tokenPrices: makeUserTokenPriceStore(namer),
        cache: makeUserCacheStore,
      }),
    ),
}) {}

export type TokenStore = DatabaseForOracle["tokens"];
export type TokenPriceStore = DatabaseForOracle["tokenPrices"];
export type CacheStore = DatabaseForOracle["cache"];
export type GlobalRefIndexStore = GlobalDatabase["refIndex"];
