import type { LogLevel } from "@logtape/logtape";

/** LogTape 认的级别。注意是 `warning` 而不是 `warn` —— 拼错这个的概率最高。 */
export const LOG_LEVELS = ["trace", "debug", "info", "warning", "error", "fatal"] as const;

/**
 * 把 env 里那个手写的 LOG_LEVEL 收成一个合法级别,认不出来就退回 `info`。
 *
 * **为什么要这道校验**:这个值是自托管者自己写进 `.dev.vars` / `wrangler.jsonc` 的。以前代码直接
 * `as LogLevel` 强转塞给 LogTape 的 configure(),于是一个拼错(`warn`)就让**每一个** server function
 * 抛错 —— 站点整体不可用,而真正的原因只躺在日志里。日志配置不该有这种杀伤力。
 *
 * 抽成独立的纯文件是为了能单测:log.ts 顶部 import 了 `cloudflare:workers`,在 jsdom 里解析不了。
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
