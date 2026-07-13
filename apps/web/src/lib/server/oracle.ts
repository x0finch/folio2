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
function build(activeVendor?: string): Oracle {
  return createOracle({
    apiKey: env.COINGECKO_API_KEY || undefined,
    activeVendor,
    createTokenStore: (source) => createTokenStore(env, { source }),
    createPlatformStore: () => createPlatformStore(env),
    createFxStore: () => createFxStore(env),
  });
}

// per-user 活跃源(#93):价格准确性相关路径(overview / history / sync 取价)用它 —— activeVendor 来自
// user_settings.active_vendor。返回一份绑定该源的门面(createOracle 是廉价惰性组装,见其定义)。
export function oracleFor(activeVendor: string): Oracle {
  return build(activeVendor);
}

// 全局(baseline)代理:无用户上下文 / 与价源无关的服务(platforms / fx / logo 端点)用,activeVendor
// 缺省 = coingecko。仿 ./db 的 server-only 单例代理:每次属性访问用当前 env 造一份门面再取子服务。
export const oracle: Oracle = new Proxy({} as Oracle, {
  get: (_target, prop: string) => (build() as unknown as Record<string, unknown>)[prop],
});
