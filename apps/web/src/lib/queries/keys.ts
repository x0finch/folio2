// Hierarchical keys: the prefix is the invalidation unit, so new queries in a domain are covered
// automatically (a missed flat key is a silent stale-data bug).
// Kept apart from queryOptions on purpose: those import server fns whose chain includes server-only
// modules, so this pure module is what lets tests verify the refresh map against real keys.
export const syncKeys = {
  all: ["sync"] as const,
  /**
   * Under `all`, so every targeted refresh covers it except the round-advance one, which reads it.
   */
  round: (portfolioId: string) => [...syncKeys.all, "round", portfolioId] as const,
};

// In the key because a pinned overview is different data; otherwise tabs would share a cache entry.
export interface PinScopeKey {
  kind: "connector" | "tag" | "account";
  connectorId?: string;
  tagId?: string;
  accountId?: string;
}

export const portfolioKeys = {
  all: ["portfolio"] as const,
  list: () => [...portfolioKeys.all, "list"] as const,
  tabs: () => [...portfolioKeys.all, "tabs"] as const,
  /** Separate from the overview so a pin change refreshes only this. */
  tabPins: (portfolioId: string) => [...portfolioKeys.tabs(), "pins", portfolioId] as const,
  /** QueryBoundary resetKey, not a react-query cache key: each atom has its own key. */
  overviewCompose: (portfolioId: string, pin?: PinScopeKey) =>
    [...portfolioKeys.all, "overview-compose", portfolioId, pin ?? null] as const,
  /** Not affected by pins: custom tabs narrow the list, never the curve. */
  history: (portfolioId: string, range: string) =>
    [...portfolioKeys.all, "history", portfolioId, range] as const,
  snapshotsPrefix: () => [...portfolioKeys.all, "snapshots"] as const,
  /** The key uses the hour-floored anchor; the request body's `at` is the real upper bound. */
  snapshots: (portfolioId: string, at: number, after?: number) =>
    [...portfolioKeys.all, "snapshots", portfolioId, at, after ?? null] as const,
  fiatRefs: (portfolioId: string) => [...portfolioKeys.all, "fiat-refs", portfolioId] as const,
  /** Refreshed after manual token changes. */
  fiatRefsPrefix: () => [...portfolioKeys.all, "fiat-refs"] as const,
  /** Chain ids are computed client-side from the snapshot data. */
  platformMeta: (chainIds: readonly string[]) =>
    [...portfolioKeys.all, "platform-meta", ...chainIds] as const,
};

export const accountKeys = {
  all: ["accounts"] as const,
  /** portfolioId is in the key: results are filtered per portfolio server-side. */
  list: (portfolioId: string) => [...accountKeys.all, "list", portfolioId] as const,
  /**
   * The range tier, not the computed `since`: that changes every render and would make a new cache
   * entry each frame.
   */
  history: (accountId: string, range: string) =>
    [...accountKeys.all, "history", accountId, range] as const,
  /** Range tier in the key, as above. */
  holdingHistory: (holdingKey: string, range: string) =>
    [...accountKeys.all, "token-value-history", holdingKey, range] as const,
  manualDetail: (accountId: string) => [...accountKeys.all, "manual-detail", accountId] as const,
};

export const tagKeys = {
  all: ["tags"] as const,
  list: (portfolioId: string) => [...tagKeys.all, "list", portfolioId] as const,
  accountLinks: (portfolioId: string) => [...tagKeys.all, "account-links", portfolioId] as const,
};

export const settingsKeys = {
  all: ["settings"] as const,
  providerKeys: () => [...settingsKeys.all, "provider-keys"] as const,
  valuation: () => [...settingsKeys.all, "valuation"] as const,
  dataStats: () => [...settingsKeys.all, "data-stats"] as const,
};

export const preferenceKeys = {
  /** UI language lives in localStorage, not here. */
  all: ["preferences"] as const,
  currency: (code: string) => [...preferenceKeys.all, "currency", code] as const,
};

export const connectorKeys = {
  /** Static within a deployment, so absent from the refresh map. */
  all: ["connectors"] as const,
  catalogue: () => [...connectorKeys.all, "catalogue"] as const,
  credentialSpecs: () => [...connectorKeys.all, "credential-specs"] as const,
};

export const tokenKeys = {
  all: ["tokens"] as const,
  catalogue: () => [...tokenKeys.all, "catalogue"] as const,
  /** Names are localized, so the locale is part of the key. */
  fiatOptions: (locale: string) => [...tokenKeys.all, "fiat-options", locale] as const,
  search: (query: string) => [...tokenKeys.all, "search", query] as const,
  enrichment: () => [...tokenKeys.all, "enrichment"] as const,
};

export const dataVersionKeys = {
  /**
   * Outside every data prefix: if it were in the batch "data.changed" invalidates, it would mark
   * the version it just fetched stale and ask again.
   */
  all: ["data-version"] as const,
};
