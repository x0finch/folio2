import { getLogger } from "@logtape/logtape";
import {
  Effect,
  FiberId,
  FiberRef,
  FiberRefs,
  HashMap,
  HashSet,
  Layer,
  Logger,
  LogLevel,
} from "effect";

// Effect logs -> LogTape. A single forwarder only: a second `Logger.replace` in an inner layer would
// silently no-op its remove and leave both forwarders active, writing every log twice. The category
// therefore travels with the log via `logCategory(...)`; default is `oracle`.
const CATEGORY = "logCategory";

/** Routes the effect's logs to the given LogTape category. */
export const logCategory = (category: string) => Effect.annotateLogs(CATEGORY, category);

const forwarder = Logger.make(({ logLevel, message, annotations }) => {
  const props = Object.fromEntries(HashMap.entries(annotations));
  const category = typeof props[CATEGORY] === "string" ? props[CATEGORY] : "oracle";
  // Routing info, not a log property.
  delete props[CATEGORY];
  const log = getLogger(["folio", category]);
  const text = Array.isArray(message) ? message.map(String).join(" ") : String(message);
  if (LogLevel.greaterThanEqual(logLevel, LogLevel.Error)) log.error(text, props);
  else if (LogLevel.greaterThanEqual(logLevel, LogLevel.Warning)) log.warn(text, props);
  // Keep debug as debug: sync backoff retries are debug-level and must stay filterable by LogTape.
  else if (LogLevel.greaterThanEqual(logLevel, LogLevel.Info)) log.info(text, props);
  else log.debug(text, props);
});

export const logTapeLogger: Layer.Layer<never> = Layer.merge(
  Logger.replace(Logger.defaultLogger, forwarder),
  // LogTape owns the level gate; Effect's default Info minimum would swallow `logDebug` first.
  Logger.minimumLogLevel(LogLevel.All),
);

/** `logTapeLogger` without a Layer (~3-7 ms CPU on a cold isolate); `effect-log.test.ts` checks both paths produce the same output. */
export const withLogTapeLogger = (refs: FiberRefs.FiberRefs): FiberRefs.FiberRefs => {
  const loggers = FiberRefs.getOrDefault(refs, FiberRef.currentLoggers);
  return refs.pipe(
    FiberRefs.updateAs({
      fiberId: FiberId.none,
      fiberRef: FiberRef.currentLoggers,
      value: HashSet.add(HashSet.remove(loggers, Logger.defaultLogger), forwarder),
    }),
    FiberRefs.updateAs({
      fiberId: FiberId.none,
      fiberRef: FiberRef.currentMinimumLogLevel,
      value: LogLevel.All,
    }),
  );
};
