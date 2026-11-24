// Types for public/sw.js so .ts unit tests can import its pure functions without enabling allowJs.
// Only swRoute and isCacheableAsset are declared; the SW event half is not unit-tested.
export type SwStrategy = "navigation" | "cache-first" | "network-only";

export interface SwRequestShape {
  method: string;
  mode: string;
  destination: string;
  sameOrigin: boolean;
  pathname: string;
}

export function swRoute(req: SwRequestShape): SwStrategy;

// Second cache-first gate: the response content type must match the destination to be cached.
export function isCacheableAsset(destination: string, contentType: string | null): boolean;
