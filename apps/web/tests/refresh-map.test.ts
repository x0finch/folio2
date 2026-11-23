import { QueryClient } from "@tanstack/react-query";
import { beforeEach, describe, expect, it } from "vitest";
import {
  accountKeys,
  portfolioKeys,
  preferenceKeys,
  settingsKeys,
  syncKeys,
  tagKeys,
  tokenKeys,
} from "@/lib/queries/keys";

import { invalidateFor, REFRESH_MAP } from "@/lib/queries/refresh";

const PF = "pf-1";
const SNAPSHOT_AT = 1_700_000_000_000;

let queryClient: QueryClient;

const seed = (queryKey: readonly unknown[]) =>
  queryClient.setQueryData([...queryKey], { seeded: true });

const isInvalidated = (queryKey: readonly unknown[]) =>
  queryClient.getQueryState([...queryKey])?.isInvalidated === true;

describe("refresh map", () => {
  beforeEach(() => {
    queryClient = new QueryClient();
  });

  it("sync.round refreshes accounts, snapshots and enrichment, without hitting other domains", async () => {
    seed(accountKeys.list(PF));
    seed(portfolioKeys.snapshots(PF, SNAPSHOT_AT));
    seed(tokenKeys.enrichment());
    seed(settingsKeys.valuation());

    await invalidateFor(queryClient, "sync.round");

    expect(isInvalidated(accountKeys.list(PF))).toBe(true);
    expect(isInvalidated(portfolioKeys.snapshots(PF, SNAPSHOT_AT))).toBe(true);
    expect(isInvalidated(tokenKeys.enrichment())).toBe(true);
    expect(isInvalidated(settingsKeys.valuation())).toBe(false);
  });

  it("sync.round does not refresh the round itself", async () => {
    seed(syncKeys.round(PF));

    await invalidateFor(queryClient, "sync.round");

    expect(isInvalidated(syncKeys.round(PF))).toBe(false);
  });

  it("sync.round covers the snapshot keys of different portfolios", async () => {
    const def = portfolioKeys.snapshots("pf-default", SNAPSHOT_AT);
    const other = portfolioKeys.snapshots("pf-other", SNAPSHOT_AT);
    for (const k of [def, other]) seed(k);

    await invalidateFor(queryClient, "sync.round");

    expect([isInvalidated(def), isInvalidated(other)]).toEqual([true, true]);
  });

  it("account.write refreshes the accounts domain, sync domain and snapshots (manual is computed on read)", async () => {
    seed(accountKeys.list("pf-1"));
    seed(accountKeys.manualDetail("a1"));
    seed(syncKeys.round("pf-1"));
    seed(portfolioKeys.snapshots("pf-1", SNAPSHOT_AT));
    seed(portfolioKeys.fiatRefs("pf-1"));
    seed(tokenKeys.enrichment());

    await invalidateFor(queryClient, "account.write");

    expect(
      [accountKeys.list("pf-1"), accountKeys.manualDetail("a1"), syncKeys.round("pf-1")].map(
        isInvalidated,
      ),
    ).toEqual([true, true, true]);
    expect(isInvalidated(portfolioKeys.snapshots("pf-1", SNAPSHOT_AT))).toBe(true);
    expect(isInvalidated(portfolioKeys.fiatRefs("pf-1"))).toBe(true);
    expect(isInvalidated(tokenKeys.enrichment())).toBe(true);
  });

  it("account.write refreshes dataStats, but not the valuation basis or provider key", async () => {
    seed(settingsKeys.dataStats());
    seed(settingsKeys.valuation());
    seed(settingsKeys.providerKeys());

    await invalidateFor(queryClient, "account.write");

    expect(isInvalidated(settingsKeys.dataStats())).toBe(true);
    expect(isInvalidated(settingsKeys.valuation())).toBe(false);
    expect(isInvalidated(settingsKeys.providerKeys())).toBe(false);
  });

  it("account.archive additionally refreshes snapshots and the tab strip", async () => {
    seed(accountKeys.list("pf-1"));
    seed(portfolioKeys.snapshots("pf-1", SNAPSHOT_AT));
    seed(portfolioKeys.tabPins("pf-1"));

    await invalidateFor(queryClient, "account.archive");

    expect(isInvalidated(accountKeys.list("pf-1"))).toBe(true);
    expect(isInvalidated(portfolioKeys.snapshots("pf-1", SNAPSHOT_AT))).toBe(true);
    expect(isInvalidated(portfolioKeys.tabPins("pf-1"))).toBe(true);
  });

  it("tag.write refreshes only the tags domain, not snapshot keys", async () => {
    seed(tagKeys.list("pf-1"));
    seed(tagKeys.accountLinks("pf-1"));
    seed(portfolioKeys.snapshots("pf-1", SNAPSHOT_AT));

    await invalidateFor(queryClient, "tag.write");

    expect([tagKeys.list("pf-1"), tagKeys.accountLinks("pf-1")].map(isInvalidated)).toEqual([
      true,
      true,
    ]);
    expect(isInvalidated(portfolioKeys.snapshots("pf-1", SNAPSHOT_AT))).toBe(false);
  });

  it("portfolio.write refreshes the tags domain and accounts domain along with it", async () => {
    seed(tagKeys.list("pf-1"));
    seed(tagKeys.accountLinks("pf-1"));
    seed(accountKeys.list("pf-1"));

    await invalidateFor(queryClient, "portfolio.write");

    expect(
      [tagKeys.list("pf-1"), tagKeys.accountLinks("pf-1"), accountKeys.list("pf-1")].map(
        isInvalidated,
      ),
    ).toEqual([true, true, true]);
  });

  it("portfolio.write refreshes the whole portfolio domain (list, tab strip and trend together)", async () => {
    const keys = [
      portfolioKeys.list(),
      portfolioKeys.tabPins("pf-1"),
      portfolioKeys.history("pf-1", "30d"),
      portfolioKeys.snapshots("pf-1", SNAPSHOT_AT),
    ];
    for (const k of keys) seed(k);

    await invalidateFor(queryClient, "portfolio.write");

    expect(keys.map(isInvalidated)).toEqual([true, true, true, true]);
  });

  it("portfolio.pin.write refreshes only the tab strip, not snapshots", async () => {
    seed(portfolioKeys.tabPins("pf-1"));
    seed(portfolioKeys.snapshots("pf-1", SNAPSHOT_AT));

    await invalidateFor(queryClient, "portfolio.pin.write");

    expect(isInvalidated(portfolioKeys.tabPins("pf-1"))).toBe(true);
    expect(isInvalidated(portfolioKeys.snapshots("pf-1", SNAPSHOT_AT))).toBe(false);
  });

  it("settings.valuation refreshes only the valuation basis key", async () => {
    seed(settingsKeys.valuation());
    seed(portfolioKeys.snapshots("pf-1", SNAPSHOT_AT));
    seed(tokenKeys.enrichment());
    seed(syncKeys.round(PF));

    await invalidateFor(queryClient, "settings.valuation");

    expect(isInvalidated(settingsKeys.valuation())).toBe(true);
    expect(
      [
        portfolioKeys.snapshots("pf-1", SNAPSHOT_AT),
        tokenKeys.enrichment(),
        syncKeys.round(PF),
      ].map(isInvalidated),
    ).toEqual([false, false, false]);
  });

  it("settings.data refreshes all related domains", async () => {
    const keys = [
      settingsKeys.dataStats(),
      syncKeys.round(PF),
      portfolioKeys.snapshots("pf-1", SNAPSHOT_AT),
      accountKeys.list("pf-1"),
      tagKeys.list("pf-1"),
      tokenKeys.enrichment(),
    ];
    for (const k of keys) seed(k);

    await invalidateFor(queryClient, "settings.data");

    expect(keys.map(isInvalidated)).toEqual([true, true, true, true, true, true]);
  });

  it("every prefix in the map lands on a known domain prefix", () => {
    const domains: readonly (readonly string[])[] = [
      syncKeys.all,
      portfolioKeys.all,
      accountKeys.all,
      tagKeys.all,
      settingsKeys.all,
      preferenceKeys.all,
      tokenKeys.all,
    ];
    for (const [event, prefixes] of Object.entries(REFRESH_MAP)) {
      expect(prefixes.length, `${event} must refresh at least one prefix`).toBeGreaterThan(0);
      for (const prefix of prefixes) {
        const matched = domains.some((d) => d.every((seg, i) => prefix[i] === seg));
        expect(
          matched,
          `${event} prefix ${JSON.stringify(prefix)} belongs to no known domain`,
        ).toBe(true);
      }
    }
  });
});
