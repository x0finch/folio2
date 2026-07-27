import { env } from "cloudflare:workers";
import { createPlatformStore, createTokenPriceHistoryStore, createTokenStore } from "@folio/db";
import { createOracle, type Oracle } from "@folio/oracle";

// 旧统一 Oracle 门面(#79)。**汇率已经不在这里**(#202b:搬进 ./oracle2,per-user 缓存)——
// 剩下代币与平台两服务,随 #202b 后续两片退场。store 实现由此注入(D1 在 @folio/db,oracle 不依赖它)。
// 皆 CoinGecko 供源;运行时换价源已废止(ADR 0014)。
//
// server-only 单例代理(仿 ./db):每次属性访问用「当前 env」造一份 oracle facade 再取子服务。
// createOracle 是廉价闭包组装(各服务惰性 getter,见其定义)→ 一次 `oracle.tokens` 只建 tokens 一套,
// 不预建 platforms。get 在访问时才碰 env → 模块加载期不触发;env 在 fetch 与 scheduled 上下文
// 均可用(见 configureLogging),故 cron 路径也走此 oracle。
// 从 @folio/oracle 门面具名 import createOracle(非客户端 bundle,分层 #21 不涉)。
export const oracle: Oracle = new Proxy({} as Oracle, {
  get: (_target, prop: string) =>
    (
      createOracle({
        apiKey: env.COINGECKO_API_KEY || undefined,
        createTokenStore: (source) => createTokenStore(env, { source }),
        createPlatformStore: () => createPlatformStore(env),
        createPriceHistoryStore: () => createTokenPriceHistoryStore(env),
      }) as unknown as Record<string, unknown>
    )[prop],
});
