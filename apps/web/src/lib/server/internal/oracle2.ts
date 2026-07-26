import { env } from "cloudflare:workers";
import {
  createGlobalTokenRefIndexStore,
  createUserCacheStore,
  createUserTokenPriceStore,
  createUserTokenStore,
} from "@folio/db";
import { createOracleFor, createOracleWarm, type OracleFor, type OracleWarm } from "@folio/oracle2";
import { createCoinGeckoUpstream, OVERRIDES, UPSTREAM_ID } from "@folio/oracle2-upstream-coingecko";
import { getLogger } from "@logtape/logtape";

// 新参考层的装配点(ADR 0023,#199/#200)。**这是全仓唯一同时认识两边的文件** ——
// 一个 import 是 D1 store,一个是 CoinGecko adapter;`@folio/oracle2` 自己两边都不认识。
//
// 与旧的 ./oracle.ts 并存到 #202(那片让 oracle2 改名接管)。

const newUpstream = () => createCoinGeckoUpstream({ apiKey: env.COINGECKO_API_KEY || undefined });

// 一个用户的参考层。**显式工厂,不是糖** —— 参考层现在装用户私有数据,拿错用户就是泄露。
// store 工厂惰性:碰 tokens 才建 tokens 那几个 store,碰 mint 只建它要的两个。
// env 在工厂被调用时才取 → 模块加载期一次都不碰(Workers 的启动 CPU 限制)。
// 命名者取 adapter 导出的常量而不是 `newUpstream().id` —— 后者会在模块加载期读 env。
export const oracleFor: OracleFor = createOracleFor({
  createTokenStore: (userId) => createUserTokenStore(env, { userId, namer: UPSTREAM_ID }),
  createTokenPriceStore: (userId) => createUserTokenPriceStore(env, { userId, namer: UPSTREAM_ID }),
  createCacheStore: (userId) => createUserCacheStore(env, { userId }),
  createRefIndexStore: () => createGlobalTokenRefIndexStore(env),
  createUpstream: newUpstream,
  // symbol → 上游 id 的策展表由 adapter 提供(它逐条写的是那一家的 id)。
  overrides: OVERRIDES,
});

// 全局维护任务:刷新 `global_token_ref_index`。**不带 userId** —— 这张表跟任何用户无关。
// env 在访问时才取 → 模块加载期不碰(Workers 的启动 CPU 限制)。
export const oracleWarm: OracleWarm = createOracleWarm({
  createRefIndexStore: () => createGlobalTokenRefIndexStore(env),
  createUpstream: newUpstream,
  // 链对照失配是静默故障(那条链的币从此没价没图却不报错)→ 落 warning,Workers Logs 可查。
  onWarn: (message, meta) => getLogger(["folio", "cron"]).warn(message, meta),
});
