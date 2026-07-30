import { env } from "cloudflare:workers";
import {
  createGlobalTokenRefIndexStore,
  createUserCacheStore,
  createUserTokenPriceStore,
  createUserTokenStore,
} from "@folio/db";
import { createOracleFor, createOracleWarm, type OracleFor, type OracleWarm } from "@folio/oracle2";
import {
  createCoinGeckoFxUpstream,
  createCoinGeckoPlatformUpstream,
  createCoinGeckoUpstream,
  OVERRIDES,
  UPSTREAM_ID,
} from "@folio/oracle2-upstream-coingecko";
import { getLogger } from "@logtape/logtape";

// 新参考层的装配点(ADR 0023,#199/#200)。**这是全仓唯一同时认识两边的文件** ——
// 一个 import 是 D1 store,一个是 CoinGecko adapter;`@folio/oracle2` 自己两边都不认识。
//
// 与旧的 ./oracle.ts 并存到 #202(那片让 oracle2 改名接管)。

// CoinGecko client 的公共配置(三个上游共用一份)。限速层的报告不在这里 —— 见 log.ts 的
// setLimitLogger:那件事是运行时的属性,设一次管所有闸,不该逐个上游透传。
const cgConfig = () => ({ apiKey: env.COINGECKO_API_KEY || undefined });

const newUpstream = () => createCoinGeckoUpstream(cgConfig());

// 当前上游的命名者。db 层不预设任何厂商(表名列名零 vendor 字样,#199),所以凡是要按命名者
// 点查 `token_refs` 的读(如手记持仓的「用户选了哪个币」)都由 app 把它传进去。
export const NAMER = UPSTREAM_ID;

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
  // 汇率上游是**另一个端口**(见 OracleConfig):当前同样落在 CoinGecko 上,但那是这里的选择,
  // 服务层不知道两者是同一家。
  createFxUpstream: () => createCoinGeckoFxUpstream(cgConfig()),
  createPlatformUpstream: () => createCoinGeckoPlatformUpstream(cgConfig()),
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
