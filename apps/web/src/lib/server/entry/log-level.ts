import type { LogLevel } from "@logtape/logtape";

/** Levels LogTape accepts; note `warning`, not `warn`. */
export const LOG_LEVELS = ["trace", "debug", "info", "warning", "error", "fatal"] as const;

/**
 * Narrows the hand-written LOG_LEVEL env to a valid level, falling back to `info`: a typo like `warn` used to
 * make every server function throw. Separate pure file because log.ts imports `cloudflare:workers`, which jsdom can't resolve.
 */
export function resolveLogLevel(
  raw: string | undefined,
  onUnknown?: (raw: string) => void,
): LogLevel {
  if (!raw) return "info";
  if ((LOG_LEVELS as readonly string[]).includes(raw)) return raw as LogLevel;
  onUnknown?.(raw);
  return "info";
}
