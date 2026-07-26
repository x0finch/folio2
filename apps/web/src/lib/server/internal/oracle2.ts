import { env } from "cloudflare:workers";
import { createGlobalTokenRefIndexStore } from "@folio/db";
import { createOracleWarm, type OracleWarm } from "@folio/oracle2";
import { createCoinGeckoUpstream } from "@folio/oracle2-upstream-coingecko";
import { getLogger } from "@logtape/logtape";

// 新参考层的装配点(ADR 0023,#199)。**这是全仓唯一同时认识两边的文件** ——
// 一个 import 是 D1 store,一个是 CoinGecko adapter;`@folio/oracle2` 自己两边都不认识。
//
// 与旧的 ./oracle.ts 并存到 #202(那片让 oracle2 改名接管)。旧读写路径仍走旧门面,
// 本片只把全局索引的 cron 接上,页面行为一个字不变;per-user 门面(`oracleFor`)在 #200 接。

const newUpstream = () =>
  createCoinGeckoUpstream({ apiKey: env.COINGECKO_API_KEY || undefined });

// 全局维护任务:刷新 `global_token_ref_index`。**不带 userId** —— 这张表跟任何用户无关。
// env 在访问时才取 → 模块加载期不碰(Workers 的启动 CPU 限制)。
export const oracleWarm: OracleWarm = createOracleWarm({
  createRefIndexStore: () => createGlobalTokenRefIndexStore(env),
  createUpstream: newUpstream,
  // 链对照失配是静默故障(那条链的币从此没价没图却不报错)→ 落 warning,Workers Logs 可查。
  onWarn: (message, meta) => getLogger(["folio", "cron"]).warn(message, meta),
});
