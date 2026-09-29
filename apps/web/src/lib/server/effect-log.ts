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

// —— Effect 的日志 → LogTape ——
// epic #362 里那句「日志换 Effect 的日志系统 + 一个转发器接回 LogTape,但只有当调用方自己持有
// Effect 并 runPromise 时才挂得上」的那个边界,#362 第 4 站推出去了:参考层里的降级与告警走
// `Effect.logWarning`,落到哪由这个 layer 决定。
//
// **只有一个转发器**(#403 片 2)。曾经想过让 `@folio/sync` 自带一层 `Logger.replace` 接自己的
// 类目 —— 那是错的,而且是**静默**错:`Logger.replace(defaultLogger, X)` 等于
// 「remove(defaultLogger) + add(X)」,而外层已经把 defaultLogger 换掉了,于是内层那次 remove 是
// 空操作,两个转发器同时在集合里 —— 每条日志写两遍,其中一遍还落在错的类目下。实测确认过。
//
// 所以类目改成**跟着日志走**:调用方用 `logCategory("sync")` 标一下,这里读它。默认 `oracle`
// (参考层是这套日志的第一个也是最大的使用者),标了就按标的来。
const CATEGORY = "logCategory";

/** 给一段 effect 标上它的日志类目 —— 决定它落到 LogTape 的哪个 logger 下。 */
export const logCategory = (category: string) => Effect.annotateLogs(CATEGORY, category);

const forwarder = Logger.make(({ logLevel, message, annotations }) => {
  const props = Object.fromEntries(HashMap.entries(annotations));
  const category = typeof props[CATEGORY] === "string" ? props[CATEGORY] : "oracle";
  // 类目是**路由信息**,不是这条日志的属性 —— 别让它出现在 properties 里。
  delete props[CATEGORY];
  const log = getLogger(["folio", category]);
  const text = Array.isArray(message) ? message.map(String).join(" ") : String(message);
  if (LogLevel.greaterThanEqual(logLevel, LogLevel.Error)) log.error(text, props);
  else if (LogLevel.greaterThanEqual(logLevel, LogLevel.Warning)) log.warn(text, props);
  // **debug 要保留成 debug**,别一律抬成 info:同步那条路的退避重试是 debug 级的,
  // 抬成 info 之后生产日志里就多出一堆本该被 LogTape 的级别配置滤掉的行。
  else if (LogLevel.greaterThanEqual(logLevel, LogLevel.Info)) log.info(text, props);
  else log.debug(text, props);
});

export const logTapeLogger: Layer.Layer<never> = Layer.merge(
  Logger.replace(Logger.defaultLogger, forwarder),
  // 门限交给 LogTape(它有自己的 `LOG_LEVEL` 配置),这一层不替它筛。
  // 不设的话 Effect 默认从 Info 起,`logDebug` 在到达 LogTape 之前就被吃掉了。
  Logger.minimumLogLevel(LogLevel.All),
);

/**
 * **同一件事,不经 Layer**:把上面那两步直接写进一份 `FiberRefs`(`runtime.ts` 手搭的 db 运行时用,
 * FOL-83 第二轮)。冷 isolate 上建 `logTapeLogger` 这张 layer 本机实测 3–7ms CPU —— 为的只是改两个
 * FiberRef 的初值。结果与 layer 逐字相同:默认 logger 换成转发器(tracer logger 照留),门限 All
 * (`effect-log.test.ts` 两条路各跑一遍、比输出)。
 */
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
