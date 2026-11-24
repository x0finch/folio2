// Pure state only (no timers / DOM / React) so it can be fully unit-tested.

/** `enabled` is the user's hide-balances setting; `revealed` is a temporary reveal. Orthogonal. */
export interface PrivacyState {
  enabled: boolean;
  revealed: boolean;
}

export type PrivacyEvent =
  | { type: "sync"; hideBalances: boolean }
  | { type: "reveal" }
  // Any leave signal (background, blur, idle timeout).
  | { type: "leave" };

export function privacyReducer(state: PrivacyState, event: PrivacyEvent): PrivacyState {
  switch (event.type) {
    case "sync":
      // Return the same reference when nothing changed so React skips the re-render.
      if (state.enabled === event.hideBalances) {
        return event.hideBalances ? state : state.revealed ? { ...state, revealed: false } : state;
      }
      return { enabled: event.hideBalances, revealed: false };
    case "reveal":
      return state.enabled && !state.revealed ? { ...state, revealed: true } : state;
    case "leave":
      return state.revealed ? { ...state, revealed: false } : state;
  }
}

export function isHidden(state: PrivacyState): boolean {
  return state.enabled && !state.revealed;
}

/** Fail-closed: with no cache (server value unknown yet) hide until `sync` arrives. */
export function resolveInitialEnabled(cached: boolean | null): boolean {
  return cached ?? true;
}

export const REVEAL_IDLE_MS = 15_000;

/** Value is "1" | "0". */
export const HIDE_BALANCES_CACHE_KEY = "folio_hide_balances";

export function parseCachedHideBalances(raw: string | null): boolean | null {
  if (raw === "1") return true;
  if (raw === "0") return false;
  return null;
}

export function serializeHideBalances(value: boolean): string {
  return value ? "1" : "0";
}
