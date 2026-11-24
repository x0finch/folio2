import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render } from "@testing-library/react";
import { IntlProvider } from "use-intl";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { messages } from "@/lib/i18n/messages";
import type { SyncRoundView, SyncStatusSummary } from "@/lib/server/sync/status";

//
//
vi.mock("@/lib/server/connectors", () => ({
  listConnectors: vi.fn(async () => ({})),
  getConnectorCredentialSpecs: vi.fn(),
}));
vi.mock("@/lib/server/sync", () => ({
  getSyncRound: vi.fn(),
}));

const { SyncPanel, hasAttention } = await import("@/components/sync-status");

const NOW = 1_700_000_000_000;
const MINUTE = 60_000;

const summary = (over: Partial<SyncStatusSummary> = {}): SyncStatusSummary => ({
  accounts: Array.from({ length: 9 }, (_, i) => ({ id: `a${i}`, label: `Acc ${i}` })),
  total: 13,
  attention: [],
  lastSyncedAt: NOW - 2 * MINUTE,
  dataStale: false,
  ...over,
});

const round = (over: Partial<SyncRoundView> = {}): SyncRoundView => ({
  roundId: "r1",
  state: "done",
  trigger: "manual",
  startedAt: NOW - 30_000,
  finishedAt: NOW - 1_000,
  total: 9,
  settled: 9,
  synced: 9,
  failed: [],
  needsKeys: 0,
  skipped: 0,
  current: null,
  unresolved: 0,
  error: null,
  statuses: {},
  ...over,
});

beforeEach(() => {
  vi.useFakeTimers({ now: NOW });
});
afterEach(() => {
  vi.useRealTimers();
});

function mount(props: {
  summary: SyncStatusSummary;
  round: SyncRoundView | null;
  startError?: string | null;
}) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const { container } = render(
    <QueryClientProvider client={client}>
      <IntlProvider locale="en" messages={messages.en} timeZone="UTC" now={new Date(NOW)}>
        <SyncPanel
          summary={props.summary}
          round={props.round}
          startError={props.startError ?? null}
          onSync={() => {}}
          onPick={() => {}}
        />
      </IntlProvider>
    </QueryClientProvider>,
  );
  return container.textContent ?? "";
}

describe("three-segment counts", () => {
  it("all succeeded: only the synced segment, counting sources that do not sync", () => {
    const text = mount({ summary: summary(), round: round() });
    expect(text).toContain("13 synced");
    expect(text).toContain("All synced");
    expect(text).not.toContain("failed");
    expect(text).not.toContain("need keys");
  });

  it("all three segments present: each count stands alone, none swallows another", () => {
    const text = mount({
      summary: summary(),
      round: round({
        synced: 6,
        needsKeys: 2,
        failed: [{ accountId: "a1", label: "OKX main", error: "invalid api key" }],
      }),
    });
    expect(text).toContain("10 synced");
    expect(text).toContain("1 failed");
    expect(text).toContain("2 need keys");
  });

  it('accounts skipped by the automatic round get their own "N skipped" segment', () => {
    const text = mount({ summary: summary(), round: round({ synced: 5, skipped: 4 }) });
    expect(text).toContain("9 synced");
    expect(text).toContain("4 skipped");
  });

  it('no round at all: the "this round" row does not appear', () => {
    const text = mount({ summary: summary(), round: null });
    expect(text).not.toContain("This round");
  });

  it('no round at all: no x/y or "N synced" is reported', () => {
    const text = mount({ summary: summary(), round: null });
    expect(text).not.toMatch(/\d+\s*(synced|failed|need keys)/);
    expect(text).not.toMatch(/\d+\s*\/\s*\d+/);
    expect(text).toContain("2 minutes ago");
  });

  it("no round at all: reports the portfolio source count (manual included), not a fraction", () => {
    const text = mount({ summary: summary(), round: null });
    expect(text).toContain("Sources");
    expect(text).toContain("13");
  });

  it("archived mid-round: the synced segment is clamped by the source total, never 13 synced / 12 sources", () => {
    const s = summary({
      accounts: Array.from({ length: 8 }, (_, i) => ({ id: `a${i}`, label: `Acc ${i}` })),
      total: 12,
    });
    const text = mount({ summary: s, round: round({ synced: 9, settled: 9 }) });
    expect(text).toContain("12 synced");
    expect(text).not.toContain("13 synced");
  });

  it("with a round that row is the three-segment form, without the source count mixed in", () => {
    const text = mount({ summary: summary(), round: round() });
    expect(text).toContain("This round");
    expect(text).not.toContain("Sources");
  });

  it("syncing: `x / N` and who is syncing, not the post-finalize row", () => {
    const text = mount({
      summary: summary(),
      round: round({
        state: "running",
        finishedAt: null,
        settled: 3,
        synced: 3,
        current: "Kraken",
      }),
    });
    expect(text).toContain("3 / 9");
    expect(text).toContain("Now syncing");
    expect(text).toContain("Kraken");
    expect(text).toContain("Syncing");
    expect(text).not.toContain("This round");
  });
});

describe("last updated", () => {
  it("while syncing it is still the last successful sync time, not —", () => {
    const text = mount({
      summary: summary(),
      round: round({ state: "running", finishedAt: null, settled: 1 }),
    });
    expect(text).toContain("2 minutes ago");
    expect(text).not.toContain("—");
  });

  it("snapshot newer than now (just stored, clock not ticked): clamped to now, never a future tense", () => {
    const text = mount({ summary: summary({ lastSyncedAt: NOW + 2 * MINUTE }), round: round() });
    expect(text).toContain("now");
    expect(text).not.toContain("in 2 minutes");
  });

  it('never synced: says "Never"', () => {
    expect(mount({ summary: summary({ lastSyncedAt: null }), round: null })).toContain("Never");
  });
});

describe("the part where something went wrong", () => {
  it("failures appear one by one: account name + upstream message", () => {
    const text = mount({
      summary: summary(),
      round: round({
        synced: 8,
        failed: [{ accountId: "a1", label: "OKX main", error: "invalid api key" }],
      }),
    });
    expect(text).toContain("Failed this round");
    expect(text).toContain("OKX main");
    expect(text).toContain("invalid api key");
  });

  it("whole round did not run: the message stays on the panel, badge turns amber", () => {
    const text = mount({
      summary: summary(),
      round: round({ synced: 0, error: "listAccounts blew up" }),
    });
    expect(text).toContain("listAccounts blew up");
    expect(text).toContain("Needs attention");
    expect(text).not.toContain("All synced");
  });

  it('interrupted: says "last round did not finish", badge turns amber', () => {
    const text = mount({
      summary: summary(),
      round: round({ state: "interrupted", finishedAt: null, settled: 2, synced: 2 }),
    });
    expect(text).toContain("stopped partway");
    expect(text).toContain("Needs attention");
  });

  it("start sync failed: a separate line, not impersonating an account failure", () => {
    const text = mount({ summary: summary(), round: null, startError: "sync failed: 401" });
    expect(text).toContain("Couldn't start the sync");
    expect(text).toContain("sync failed: 401");
    expect(text).toContain("Needs attention");
  });

  it("sources needing attention are still listed one by one", () => {
    const text = mount({
      summary: summary({
        attention: [
          {
            id: "z",
            label: "Zerion",
            connectorId: "evm",
            kind: "missing-credentials",
            takenAt: null,
          },
        ],
      }),
      round: round(),
    });
    expect(text).toContain("Missing credentials");
  });
});

describe("hasAttention", () => {
  it("summary fine and this round fine: false", () => {
    expect(hasAttention(summary(), round())).toBe(false);
  });

  it('no round at all: false (never synced is not "something wrong", that goes through the list)', () => {
    expect(hasAttention(summary(), null)).toBe(false);
  });

  it("summary list non-empty: true", () => {
    expect(
      hasAttention(
        summary({
          attention: [
            { id: "z", label: "Z", connectorId: "evm", kind: "missing-credentials", takenAt: null },
          ],
        }),
        round(),
      ),
    ).toBe(true);
  });

  it("this round has failures: true (the summary cannot see such failures: the account often still has an old snapshot and complete credentials)", () => {
    expect(
      hasAttention(
        summary(),
        round({ failed: [{ accountId: "a1", label: "OKX", error: "invalid api key" }] }),
      ),
    ).toBe(true);
  });

  it("whole round did not run: true", () => {
    expect(hasAttention(summary(), round({ error: "listAccounts blew up" }))).toBe(true);
  });

  it("interrupted: true (it has no results at all, the summary sees it even less)", () => {
    expect(hasAttention(summary(), round({ state: "interrupted", finishedAt: null }))).toBe(true);
  });

  it("start sync itself failed: true", () => {
    expect(hasAttention(summary(), null, "sync failed: 401")).toBe(true);
  });

  it("overall data too old (dataStale): true, even with empty attention, which is exactly the hole of the green pill bug", () => {
    expect(hasAttention(summary({ dataStale: true }), round())).toBe(true);
  });
});
