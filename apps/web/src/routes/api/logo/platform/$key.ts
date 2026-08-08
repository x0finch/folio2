import { PlatformService } from "@folio/oracle";
import { createFileRoute } from "@tanstack/react-router";
import { Effect } from "effect";
import { connectorPlatformMeta } from "@/lib/server/internal/connector-platform";
import { serveLogo } from "@/lib/server/internal/logo";
import { runRequest } from "@/lib/server/internal/oracle";
import { userIdOf } from "@/lib/server/internal/route-auth";

// 平台 logo 代理:platform key(如 evm:1,含 `:` → URL 编码为一段)→ 上游图 → 透传 + 缓存头。
// 见 ADR 0008 / #20。场馆键(manual/exchange:/perp:)的图取连接器自带 logo,不查 CoinGecko(#52);
// 链键才经 platforms.resolve(cache-only)。
//
// **链键那一档改成按用户读了**(#202b):平台缓存搬进 per-user 的 `user_cache`,拿图得知道是谁。
// 与代币 logo 端点(#201)同款代价 —— 响应转 `private`,边缘缓存没了,浏览器仍缓存 1 天。
// 这里的账比代币那边小得多:平台键就那么几十个,每个用户第一次各回源一趟而已。
//
// **它仍然不是隐私收口**:平台键是全局枚举(`evm:1` / `bitcoin` / `binance`,代码里写着),
// 拿到它说明不了任何人的持仓。改 private 纯粹是因为响应现在依赖 Cookie,不能进共享缓存。
// 连接器自带图那一档压根不碰缓存,所以它照旧公开、照旧走边缘缓存。
export const Route = createFileRoute("/api/logo/platform/$key")({
  server: {
    handlers: {
      GET: async ({ params, request }: { params: { key: string }; request: Request }) => {
        // 场馆键命中即用连接器自带 logo,绝不落 platforms(即便 manual 无图)。
        const cm = connectorPlatformMeta(params.key);
        if (cm) return serveLogo(async () => cm.logo, "platform", params.key);

        // 链键才查缓存,那一档才需要 userId。未登录 → 与「没有这张图」同一条路。
        const userId = await userIdOf(request);
        return serveLogo(
          async () =>
            userId
              ? (
                  await runRequest(
                    userId,
                    Effect.flatMap(PlatformService, (p) => p.resolve([params.key])),
                  )
                ).get(params.key)?.logo
              : undefined,
          "platform",
          params.key,
          { private: true },
        );
      },
    },
  },
});
