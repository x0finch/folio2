import { vi } from "vitest";

// 组合 / 账户这几条读路径的**假服务端**:只替换 server fn 这一层 I/O(取数),queryOptions、
// 浏览器合并、readJson / snapshotsFromWire 解线上形状都走真代码。各测试文件用
// `vi.mock("@/lib/server/<域>", () => import("./helpers/fake-portfolio-server").then((m) => m.modules.<域>))`
// 接上;世界状态由 `world` 描述,`resetWorld()` 每个用例复位。

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

// 快照的线上形状(FOL-92):D1 原样行的位置元组。
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
  // `after` 只有「24h 前」那一组会带(见 snapshots.ts)。
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
  // mockReset 清调用记录并回到 vi.fn(impl) 的原实现 —— 用例里临时换的实现不串到下一个用例。
  for (const fn of Object.values(server)) fn.mockReset();
}
