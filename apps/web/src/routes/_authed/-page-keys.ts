// Kept dependency-free: the app shell file also hosts AppShellSkeleton, which must render with no
// providers, and importing `-pages` would drag in the whole server-side query chain.
const PAGE_KEYS = ["overview", "accounts", "insights", "settings"] as const;
export type PageKey = (typeof PAGE_KEYS)[number];

export const DEFAULT_PAGE = "overview" satisfies PageKey;
/** Overview has no path segment; `/overview` is not a valid URL. */
export type PageSlug = Exclude<PageKey, typeof DEFAULT_PAGE>;

export function isPageSlug(value: string): value is PageSlug {
  return value !== DEFAULT_PAGE && (PAGE_KEYS as readonly string[]).includes(value);
}
