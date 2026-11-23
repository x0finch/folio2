import { env } from "cloudflare:workers";
import { AsyncLocalStorage } from "node:async_hooks";
import { configure, getConsoleSink, getJsonLinesFormatter } from "@logtape/logtape";
import { getPrettyFormatter } from "@logtape/pretty";
import { LOG_LEVELS, resolveLogLevel } from "./log-level";

// One-time LogTape setup, idempotent; called by the worker entry before fetch/scheduled. Server-only (reads env).
// Formatter: LOG_PRETTY=true gives colored output (local / wrangler tail), otherwise JSON Lines for Workers Logs.
// contextLocalStorage uses AsyncLocalStorage (nodejs_compat) so `withContext` is implicit.
let configured = false;

export async function configureLogging(): Promise<void> {
  if (configured) return;
  configured = true;
  const e = env as unknown as { LOG_LEVEL?: string; LOG_PRETTY?: string };
  // An unrecognized LOG_LEVEL falls back to info instead of 500ing the site.
  const lowestLevel = resolveLogLevel(e.LOG_LEVEL, (raw) =>
    console.warn(
      `[folio] Ignoring unknown LOG_LEVEL "${raw}"; using "info". Valid: ${LOG_LEVELS.join(" | ")}`,
    ),
  );
  // pretty omits properties by default; dev needs userId / accountId.
  const formatter =
    e.LOG_PRETTY === "true" ? getPrettyFormatter({ properties: true }) : getJsonLinesFormatter();
  await configure({
    sinks: { console: getConsoleSink({ formatter }) },
    loggers: [
      { category: ["folio"], sinks: ["console"], lowestLevel },
      // Silences LogTape's own meta notices below warning.
      { category: ["logtape", "meta"], sinks: ["console"], lowestLevel: "warning" },
    ],
    contextLocalStorage: new AsyncLocalStorage(),
  });
}
