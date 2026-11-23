import type { AccountTagLink } from "@folio/db";
import { Cause, Effect, Exit, Layer, Option } from "effect";
import { accountsMatchingPin, toTabPin } from "@/lib/core/accounts-in-view";
import {
  accountRowsFromRaw,
  assembleAccountHoldingsData,
  assemblePortfolioSnapshotData,
  computeHomeTabStrip,
  connectorMetaForOverview,
  floorToHour,
  GAIN_START_FLOOR_MS,
  GAIN_WINDOW_MS,
  overviewChainIds,
  overviewFromSnapshotData,
} from "@/lib/core/portfolio";
import { snapshotsFromWire } from "@/lib/core/snapshot-wire";
import { handleListAccounts } from "@/lib/server/accounts/list";
import { ConnectorRegistry } from "@/lib/server/connectors/registry";
import type { AppError } from "@/lib/server/errors";
import { handleGetFiatRefs } from "@/lib/server/portfolio/fiat-refs";
import { handleResolvePlatformMeta } from "@/lib/server/portfolio/platform-meta";
import type { PortfolioScope } from "@/lib/server/portfolio/scope";
import { handleGetSnapshots } from "@/lib/server/portfolio/snapshots";
import { runForUser, type UserServices } from "@/lib/server/runtime";
import { handleGetValuationSettings } from "@/lib/server/settings/valuation";
import { handleGetPortfolioTabPins } from "@/lib/server/tab-pins/read";
import { handleListAccountTags } from "@/lib/server/tags/account-tags";
import { handleListTags } from "@/lib/server/tags/list";
import { handleGetTokenEnrichment } from "@/lib/server/tokens/enrichment";
import { realRegistry } from "./fakes";

// Handlers run through the production `runForUser` (no test-only layer), so wiring matches prod.

export const call = <A, E extends AppError, R extends UserServices>(
  userId: string,
  effect: Effect.Effect<A, E, R>,
): Promise<A> => runForUser(userId, effect);

/** Use for failure cases instead of `.rejects`, which only sees a `FiberFailure` string, not the tag. */
export const callExit = <A, E extends AppError, R extends UserServices>(
  userId: string,
  effect: Effect.Effect<A, E, R>,
): Promise<Exit.Exit<A, E>> => runForUser(userId, Effect.exit(effect)) as Promise<Exit.Exit<A, E>>;

/** Inner provide wins over the one `runForUser` applies outside, so the fake connector takes effect. */
export const callWithRegistry = <A, E extends AppError, R extends UserServices>(
  userId: string,
  registry: ConnectorRegistry,
  effect: Effect.Effect<A, E, R>,
): Promise<A> =>
  runForUser(userId, Effect.provide(effect, Layer.succeed(ConnectorRegistry, registry)));

export const callWithRegistryExit = <A, E extends AppError, R extends UserServices>(
  userId: string,
  registry: ConnectorRegistry,
  effect: Effect.Effect<A, E, R>,
): Promise<Exit.Exit<A, E>> =>
  runForUser(
    userId,
    Effect.exit(Effect.provide(effect, Layer.succeed(ConnectorRegistry, registry))),
  ) as Promise<Exit.Exit<A, E>>;

/** The typed failure, or `undefined` on success or defect (assert defects with `Cause.isDie`). */
export const failureOf = <A, E>(exit: Exit.Exit<A, E>): E | undefined =>
  Exit.isFailure(exit) ? Option.getOrUndefined(Cause.failureOption(exit.cause)) : undefined;

/** `getSnapshots` plus the client-side wire decode, so assertions see what the page sees. */
export const getSnapshotsDecoded = (data: Parameters<typeof handleGetSnapshots>[0]) =>
  Effect.map(handleGetSnapshots(data), snapshotsFromWire);

export const readSnapshotData = async (userId: string, data: PortfolioScope = {}) => {
  const anchor = floorToHour(Date.now());
  const portfolioId = data.portfolioId;
  const tabPin = toTabPin(data.pin);
  const needsTagLinks = tabPin?.kind === "tag";

  const [
    accounts,
    snapshotsNow,
    snapshotsPrev,
    settings,
    enrichment,
    fiatRefsData,
    registry,
    tagLinks,
  ] = await Promise.all([
    call(userId, handleListAccounts({ portfolioId })),
    call(userId, getSnapshotsDecoded({ portfolioId, at: Date.now() })),
    call(
      userId,
      getSnapshotsDecoded({
        portfolioId,
        at: anchor - GAIN_WINDOW_MS,
        after: anchor - GAIN_START_FLOOR_MS,
      }),
    ),
    call(userId, handleGetValuationSettings()),
    call(userId, handleGetTokenEnrichment()),
    call(userId, handleGetFiatRefs({ portfolioId })),
    realRegistry(),
    needsTagLinks
      ? call(userId, handleListAccountTags({ portfolioId }))
      : Promise.resolve([] as AccountTagLink[]),
  ]);

  const active = accounts.filter((a) => a.archivedAt == null);
  const scopedAccounts = tabPin ? accountsMatchingPin(active, tabPin, tagLinks) : active;
  const scopedIds = new Set(scopedAccounts.map((a) => a.id));
  const scopedSnapshotsNow = snapshotsNow.filter((s) => scopedIds.has(s.accountId));
  const scopedSnapshotsPrev = snapshotsPrev.filter((s) => scopedIds.has(s.accountId));

  const connectorMeta = connectorMetaForOverview(
    scopedAccounts,
    scopedSnapshotsNow,
    registry.catalog,
  );
  const connectorLookup = (key: string) => {
    const entry = registry.catalog[key];
    return entry ? { name: entry.label, logo: entry.logo } : null;
  };
  const byAccount = new Map(
    scopedSnapshotsNow.map((s) => [
      s.accountId,
      { snapshot: { takenAt: s.takenAt }, balances: s.balances },
    ]),
  );
  const chainIds = overviewChainIds(scopedAccounts, byAccount, connectorLookup);
  const { platformMeta } = await call(userId, handleResolvePlatformMeta({ chainIds }));

  return assemblePortfolioSnapshotData({
    accounts: scopedAccounts,
    snapshotsNow: scopedSnapshotsNow,
    snapshotsPrev: scopedSnapshotsPrev,
    enriched: new Map(enrichment.enriched),
    mode: settings.valuationMode,
    platformMeta,
    connectorMeta,
    fiatRefs: fiatRefsData.fiatRefs,
    now: anchor,
  });
};

/** Overview as the home page computes it client-side (mirrors the frontend compose step). */
export const readOverview = async (userId: string, data: PortfolioScope = {}) =>
  overviewFromSnapshotData(await readSnapshotData(userId, data));

const readAccountHoldingsRaw = async (userId: string, data: { portfolioId?: string } = {}) => {
  const anchor = floorToHour(Date.now());
  const [accounts, snapshotsNow, snapshotsPrev, settings, enrichment] = await Promise.all([
    call(userId, handleListAccounts({ portfolioId: data.portfolioId })),
    call(userId, getSnapshotsDecoded({ portfolioId: data.portfolioId, at: Date.now() })),
    call(
      userId,
      getSnapshotsDecoded({
        portfolioId: data.portfolioId,
        at: anchor - GAIN_WINDOW_MS,
        after: anchor - GAIN_START_FLOOR_MS,
      }),
    ),
    call(userId, handleGetValuationSettings()),
    call(userId, handleGetTokenEnrichment()),
  ]);
  return assembleAccountHoldingsData({
    accounts: accounts.map((a) => ({ id: a.id, label: a.label, archivedAt: a.archivedAt })),
    snapshotsNow,
    snapshotsPrev,
    mode: settings.valuationMode,
    enriched: new Map(enrichment.enriched),
  });
};

export const readAccountHoldingsView = async (
  userId: string,
  data: { portfolioId?: string } = {},
) => accountRowsFromRaw(await readAccountHoldingsRaw(userId, data));

export const readTabStrip = async (userId: string, data: { portfolioId?: string } = {}) => {
  const [snapshot, tabPins, tags] = await Promise.all([
    readSnapshotData(userId, { portfolioId: data.portfolioId }),
    call(userId, handleGetPortfolioTabPins()),
    call(userId, handleListTags({ portfolioId: data.portfolioId })),
  ]);
  return computeHomeTabStrip(snapshot, tabPins, tags);
};
