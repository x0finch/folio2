// Pure timing decisions for the splash, kept out of React so they can be tested exhaustively.

export type SplashPhase = "preparing" | "loading" | "updating" | "exit";

export interface SplashInput {
  /** False on the SSR frame and first hydration render. */
  hydrated: boolean;
  /** TanStack Router `status === "idle"`. */
  routerIdle: boolean;
  /** Floor so the splash doesn't just flicker on fast devices. */
  minElapsed: boolean;
  /** Hard timeout: release no matter how slow. */
  maxElapsed: boolean;
  updating: boolean;
}

/** Order is priority: updating wins over everything, then preparing, timeout, ready, loading. */
export function splashPhase(i: SplashInput): SplashPhase {
  if (i.updating) return "updating";
  if (!i.hydrated) return "preparing";
  if (i.maxElapsed) return "exit";
  if (i.routerIdle && i.minElapsed) return "exit";
  return "loading";
}

export const SPLASH_LOGO_SIZE = 88;

// Mirrors beUI's `--background`; shared by SPLASH_STYLE and the theme-color meta.
export const SPLASH_COLOR_DARK = "#151515";
export const SPLASH_COLOR_LIGHT = "#fcfcfc";

/** Minimum visible time per phase message. */
export const SPLASH_MIN_MS = 700;
export const SPLASH_MAX_MS = 8000;
/** Must match the keyframe durations in SPLASH_STYLE. */
export const SPLASH_EXIT_MS = 520;
