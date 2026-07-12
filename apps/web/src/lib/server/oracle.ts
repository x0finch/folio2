import { createFxStore, createPlatformStore, createTokenStore } from "@folio/db";
import { createOracle, type Oracle } from "@folio/oracle";

// 统一 Oracle 装配点(#79):代币 / 平台 / 汇率三服务经一处 createOracle 组装,替代旧的
// buildTokens/buildPlatforms/buildFx 三处。store 实现由此注入(D1 在 @folio/db,oracle 不依赖它);
// vendor 路由 + 缺能力回退 baseline 在 oracle 内部。activeVendor 缺省 = coingecko(per-user 设置见 P3-3)。
// server-only(引 @folio/db);从 @folio/oracle 门面具名 import createOracle(非客户端 bundle,分层 #21 不涉)。
export function buildOracle(bindings: Cloudflare.Env): Oracle {
  const apiKey = bindings.COINGECKO_API_KEY || undefined;
  return createOracle({
    apiKey,
    createTokenStore: (source) => createTokenStore(bindings, { source }),
    platformStore: createPlatformStore(bindings),
    fxStore: createFxStore(bindings),
  });
}
