import { getLogger } from "@logtape/logtape";
import { Context, Effect, Layer, Logger, LogLevel, References } from "effect";

// Effect logs -> LogTape. A single forwarder only: the category travels with the log via
// `logCategory(...)` (default `oracle`) instead of a second logger per area.
const CATEGORY = "logCategory";

/** Routes the effect's logs to the given LogTape category. */
export const logCategory = (category: string) => Effect.annotateLogs(CATEGORY, category);

const atLeast = (level: LogLevel.LogLevel, floor: LogLevel.LogLevel) =>
  LogLevel.isGreaterThanOrEqualTo(level, floor);

const forwarder = Logger.make(({ logLevel, message, fiber }) => {
  const props: Record<string, unknown> = { ...fiber.getRef(References.CurrentLogAnnotations) };
  const category = typeof props[CATEGORY] === "string" ? props[CATEGORY] : "oracle";
  // Routing info, not a log property.
  delete props[CATEGORY];
  const log = getLogger(["folio", category]);
  const text = Array.isArray(message) ? message.map(String).join(" ") : String(message);
  if (atLeast(logLevel, "Error")) log.error(text, props);
  else if (atLeast(logLevel, "Warn")) log.warn(text, props);
  // Keep debug as debug: sync backoff retries are debug-level and must stay filterable by LogTape.
  else if (atLeast(logLevel, "Info")) log.info(text, props);
  else log.debug(text, props);
});

const loggers: ReadonlySet<Logger.Logger<unknown, unknown>> = new Set([forwarder]);

// LogTape owns the level gate; Effect's default Info minimum would swallow `logDebug` first.
export const logTapeLogger: Layer.Layer<never> = Layer.mergeAll(
  Layer.succeed(References.CurrentLoggers, loggers),
  Layer.succeed(References.MinimumLogLevel, "All"),
);

/** `logTapeLogger` without a Layer (~3-7 ms CPU on a cold isolate); `effect-log.test.ts` checks both paths produce the same output. */
export const withLogTapeLogger = <R>(context: Context.Context<R>): Context.Context<R> =>
  context.pipe(
    Context.add(References.CurrentLoggers, loggers),
    Context.add(References.MinimumLogLevel, "All"),
  );
