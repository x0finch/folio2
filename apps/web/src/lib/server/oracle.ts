import { env } from "cloudflare:workers";
import { createFxStore, createPlatformStore, createTokenStore } from "@folio/db";
import { createOracle, type Oracle } from "@folio/oracle";

// 统一 Oracle 门面(#79):代币 / 平台 / 汇率三服务经一处 createOracle 组装,替代旧的
// buildTokens/buildPlatforms/buildFx 三处。store 实现由此注入(D1 在 @folio/db,oracle 不依赖它);
// vendor 路由 + 缺能力回退 baseline 在 oracle 内部。activeVendor 缺省 = coingecko(per-user 设置见 P3-3)。
//
// server-only 单例代理(仿 ./db):每次属性访问用「当前 env」造一份 oracle facade 再取子服务。
// createOracle 是廉价闭包组装(三服务惰性 getter,见其定义)→ 一次 `oracle.tokens` 只建 tokens 一套,
// 不预建 platforms/fx。get 在访问时才碰 env → 模块加载期不触发;env 在 fetch 与 scheduled 上下文
// 均可用(见 configureLogging),故 cron 路径也走此 oracle。
// 从 @folio/oracle 门面具名 import createOracle(非客户端 bundle,分层 #21 不涉)。
export const oracle: Oracle = new Proxy({} as Oracle, {
  get: (_target, prop: string) =>
    (
      createOracle({
        apiKey: env.COINGECKO_API_KEY || undefined,
        createTokenStore: (source) => createTokenStore(env, { source }),
        platformStore: createPlatformStore(env),
        fxStore: createFxStore(env),
      }) as unknown as Record<string, unknown>
    )[prop],
});
