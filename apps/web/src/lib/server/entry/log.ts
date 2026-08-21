import { env } from "cloudflare:workers";
import { AsyncLocalStorage } from "node:async_hooks";
import { configure, getConsoleSink, getJsonLinesFormatter } from "@logtape/logtape";
import { getPrettyFormatter } from "@logtape/pretty";
import { LOG_LEVELS, resolveLogLevel } from "./log-level";

// LogTape 一次性配置(worker 入口在处理 fetch/scheduled 前调用,幂等)。server-only(读 env)。
// getLogger/withContext 各处直接从 "@logtape/logtape" 引入(纯,无 cloudflare:workers,不污染客户端包)。
// formatter 按环境:LOG_PRETTY=true → @logtape/pretty 彩色(本地终端 / wrangler tail);
// 否则 JSON Lines(生产:喂 Workers Logs 自动抽字段索引)。
// contextLocalStorage 用 node:async_hooks 的 AsyncLocalStorage(CF 开了 nodejs_compat)→ withContext 隐式上下文。
let configured = false;

export async function configureLogging(): Promise<void> {
  if (configured) return;
  configured = true;
  const e = env as unknown as { LOG_LEVEL?: string; LOG_PRETTY?: string };
  // 认不出来的 LOG_LEVEL 退回 info 而不是把站点整体搞 500,理由见 resolveLogLevel 的注释。
  const lowestLevel = resolveLogLevel(e.LOG_LEVEL, (raw) =>
    console.warn(
      `[folio] Ignoring unknown LOG_LEVEL "${raw}"; using "info". Valid: ${LOG_LEVELS.join(" | ")}`,
    ),
  );
  // pretty 默认不渲染 properties(消息后的结构化字段),开发期要看到 userId/accountId 等 → properties:true。
  const formatter =
    e.LOG_PRETTY === "true" ? getPrettyFormatter({ properties: true }) : getJsonLinesFormatter();
  await configure({
    sinks: { console: getConsoleSink({ formatter }) },
    loggers: [
      { category: ["folio"], sinks: ["console"], lowestLevel },
      // 压掉 LogTape 自身的 meta 提示噪音(只在 warning 以上才输出)。
      { category: ["logtape", "meta"], sinks: ["console"], lowestLevel: "warning" },
    ],
    contextLocalStorage: new AsyncLocalStorage(),
  });
}
