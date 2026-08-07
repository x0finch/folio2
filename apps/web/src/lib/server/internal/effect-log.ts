import { getLogger } from "@logtape/logtape";
import { HashMap, type Layer, Logger, LogLevel } from "effect";

// —— Effect 的日志 → LogTape ——
// epic #362 里那句「日志换 Effect 的日志系统 + 一个转发器接回 LogTape,但只有当调用方自己持有
// Effect 并 runPromise 时才挂得上」的那个边界,这一站推出去了:参考层里的降级与告警走
// `Effect.logWarning`,落到哪由这个 layer 决定。
export const logTapeLogger: Layer.Layer<never> = Logger.replace(
  Logger.defaultLogger,
  Logger.make(({ logLevel, message, annotations }) => {
    const log = getLogger(["folio", "oracle"]);
    const text = Array.isArray(message) ? message.map(String).join(" ") : String(message);
    const props = Object.fromEntries(HashMap.entries(annotations));
    if (LogLevel.greaterThanEqual(logLevel, LogLevel.Error)) log.error(text, props);
    else if (LogLevel.greaterThanEqual(logLevel, LogLevel.Warning)) log.warn(text, props);
    else log.info(text, props);
  }),
);
