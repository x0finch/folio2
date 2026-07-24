import { createFileRoute } from "@tanstack/react-router";
import { connectorPlatformMeta } from "@/lib/server/internal/connector-platform";
import { serveLogo } from "@/lib/server/internal/logo";
import { oracle } from "@/lib/server/internal/oracle";

// 公开(无 requireAuth)平台 logo 代理:platform key(如 chain:bitcoin,含 `:` → URL 编码为一段)
// → 上游图 → 透传 + 边缘缓存头。见 ADR 0008 / #20。
// 场馆键(manual/exchange:/perp:)的图取连接器自带 logo,不查 CoinGecko(#52);链键才经 platforms.resolve(cache-only)。
export const Route = createFileRoute("/api/logo/platform/$key")({
  server: {
    handlers: {
      GET: ({ params }: { params: { key: string } }) =>
        serveLogo(
          async () => {
            // 场馆键(manual/exchange:/perp:)命中即用连接器自带 logo,绝不落 platforms(即便 manual 无图);
            // 只有链键才查 platforms.resolve(cache-only)。
            const cm = connectorPlatformMeta(params.key);
            if (cm) return cm.logo;
            return (await oracle.platforms.resolve([params.key])).get(params.key)?.logo;
          },
          "platform",
          params.key,
        ),
    },
  },
});
