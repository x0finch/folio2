import { createFileRoute } from "@tanstack/react-router";
import { defiProtocolLogoUrl } from "@/lib/server/internal/defi-logo";
import { serveLogo } from "@/lib/server/internal/logo";
import { userIdOf } from "@/lib/server/internal/route-auth";

// DeFi 协议 logo 代理:协议名(路由段,含空格等已 URL 编码)→ 从该用户最新快照 meta 解析出上游图
// → 透传 + 缓存头。见 ADR 0008 / #126。
//
// **按用户收口**(同代币 logo #201):协议图 URL 藏在该用户快照的 meta 里,`oracleFor` 之外看不到;
// 未登录 / 该用户没有此协议 → 同一条「没有这张图」的路。响应 `private`(带 Cookie → 边缘缓存 bypass),
// 浏览器仍缓存 1 天。协议图本身是公共数据,但「这个用户有没有这个协议」不是。
export const Route = createFileRoute("/api/logo/defi/$protocol")({
  server: {
    handlers: {
      GET: async ({ params, request }: { params: { protocol: string }; request: Request }) => {
        const userId = await userIdOf(request);
        return serveLogo(
          async () => (userId ? defiProtocolLogoUrl(userId, params.protocol) : undefined),
          "defi",
          params.protocol,
          { private: true },
        );
      },
    },
  },
});
