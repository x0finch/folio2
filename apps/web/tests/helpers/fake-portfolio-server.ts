import { vi } from "vitest";

// Fake server for the portfolio/account read paths: only the server-fn I/O is replaced; queryOptions,
// client-side merging and wire decoding run the real code. Wire it in with
// `vi.mock("@/lib/server/<domain>", () => import("./helpers/fake-portfolio-server").then((m) => m.modules.<domain>))`;
// state lives in `world`, reset per test with `resetWorld()`.

export interface FakeBalance {
  id: string;
  amount: number;
  usdValue: number;
  kind?: string;
  platform?: string | null;
  tokenId?: string | null;
  metaJson?: string | null;
}

export interface FakeSnapshot {
  accountId: string;
  takenAt: number;
  totalUsd: number;
  balances: FakeBalance[];
}

export interface FakeAccount {
  id: string;
  connectorId: string;
  label: string;
  platform: string | null;
  createdAt: number;
  archivedAt: number | null;
  needsCredentials?: boolean;
}

export const account = (over: Partial<FakeAccount> & { id: string }): FakeAccount => ({
  connectorId: "binance",
  label: over.id.toUpperCase(),
  platform: null,
  createdAt: 0,
  archivedAt: null,
  ...over,
});

export interface FakeTag {
  id: string;
  name: string;
  portfolioId: string;
  userId: string;
  sortOrder: number;
  createdAt: number;
}

export const tag = (id: string, name: string): FakeTag => ({
  id,
  name,
  portfolioId: "p1",
  userId: "u1",
  sortOrder: 0,
  createdAt: 0,
});

interface World {
  accounts: Record<string, FakeAccount[]>;
  snapshotsNow: FakeSnapshot[];
  snapshotsPrev: FakeSnapshot[];
  catalog: Record<string, { label: string; logo?: string }>;
  valuationMode: "self-first" | "source-first";
  enriched: [string, Record<string, unknown>][];
  fiatRefs: [string, string][];
  platformMeta: [string, { name: string; logo?: string }][];
  tags: FakeTag[];
  accountTags: { accountId: string; tagId: string }[];
  tabPins: { pins: Record<string, unknown>[]; connectorMeta: [string, { name: string }][] };
}

const emptyWorld = (): World => ({
  accounts: {},
  snapshotsNow: [],
  snapshotsPrev: [],
  catalog: {},
  valuationMode: "self-first",
  enriched: [],
  fiatRefs: [],
  platformMeta: [],
  tags: [],
  accountTags: [],
  tabPins: { pins: [], connectorMeta: [] },
});

export const world: World = emptyWorld();

const json = (body: unknown) => new Response(JSON.stringify(body));

// Snapshot wire shape: the D1 row as a positional tuple.
const toWire = (snaps: FakeSnapshot[]) => ({
  snapshots: snaps.map((s) => [s.accountId, s.takenAt, s.totalUsd, null]),
  balances: snaps.flatMap((s) =>
    s.balances.map((b) => [
      s.accountId,
      b.id,
      b.amount,
      b.usdValue,
      b.kind ?? "token",
      null,
      b.platform ?? null,
      b.tokenId ?? null,
      b.metaJson ?? null,
    ]),
  ),
});

type Data<T> = { data: T };

export const server = {
  listAccounts: vi.fn(async ({ data }: Data<{ portfolioId: string }>) =>
    json(world.accounts[data.portfolioId] ?? []),
  ),
  getAccountHistory: vi.fn(async (_: Data<Record<string, unknown>>) => json({ points: [] })),
  getTokenValueHistory: vi.fn(async (_: Data<Record<string, unknown>>) => json({ points: [] })),
  getManualAccount: vi.fn(async ({ data }: Data<{ accountId: string }>) => ({
    accountId: data.accountId,
  })),
  // Only the "24h ago" group carries `after`.
  getSnapshots: vi.fn(async ({ data }: Data<{ portfolioId: string; at: number; after?: number }>) =>
    json(toWire(data.after == null ? world.snapshotsNow : world.snapshotsPrev)),
  ),
  getFiatRefs: vi.fn(async (_: Data<{ portfolioId: string }>) => ({ fiatRefs: world.fiatRefs })),
  resolvePlatformMeta: vi.fn(async (_: Data<{ chainIds: string[] }>) => ({
    platformMeta: world.platformMeta,
  })),
  getPortfolioHistory: vi.fn(async (_: Data<{ portfolioId: string; range: string }>) =>
    json({ points: [] }),
  ),
  listPortfolios: vi.fn(async () => ({ portfolios: [], defaultId: null })),
  getPortfolioTabPins: vi.fn(async (_: Data<{ portfolioId: string }>) => world.tabPins),
  getValuationSettings: vi.fn(async () => ({ valuationMode: world.valuationMode })),
  getProviderKeyStatus: vi.fn(async () => ({})),
  getDataStats: vi.fn(async () => ({})),
  getDataVersion: vi.fn(async () => ({ version: 0 })),
  listTags: vi.fn(async (_: Data<{ portfolioId: string }>) => world.tags),
  listAccountTags: vi.fn(async (_: Data<{ portfolioId: string }>) => world.accountTags),
  getTokenEnrichment: vi.fn(async () => json({ enriched: world.enriched })),
  listConnectors: vi.fn(async () => world.catalog),
  getConnectorCredentialSpecs: vi.fn(async () => ({})),
};

export const modules = {
  accounts: { listAccounts: server.listAccounts, getAccountHistory: server.getAccountHistory },
  holdings: { getTokenValueHistory: server.getTokenValueHistory },
  manualTokens: { getManualAccount: server.getManualAccount },
  portfolio: {
    getSnapshots: server.getSnapshots,
    getFiatRefs: server.getFiatRefs,
    resolvePlatformMeta: server.resolvePlatformMeta,
    getPortfolioHistory: server.getPortfolioHistory,
  },
  portfolios: { listPortfolios: server.listPortfolios },
  tabPins: { getPortfolioTabPins: server.getPortfolioTabPins },
  settings: {
    getValuationSettings: server.getValuationSettings,
    getProviderKeyStatus: server.getProviderKeyStatus,
    getDataStats: server.getDataStats,
    getDataVersion: server.getDataVersion,
  },
  tags: { listTags: server.listTags, listAccountTags: server.listAccountTags },
  tokens: {
    getTokenEnrichment: server.getTokenEnrichment,
    listFiatOptions: vi.fn(),
    listTokenCatalogue: vi.fn(),
    listTokens: vi.fn(),
  },
  connectors: {
    listConnectors: server.listConnectors,
    getConnectorCredentialSpecs: server.getConnectorCredentialSpecs,
  },
};

export function resetWorld(): void {
  Object.assign(world, emptyWorld());
  // mockReset restores the vi.fn(impl) default so per-test overrides don't leak.
  for (const fn of Object.values(server)) fn.mockReset();
}
