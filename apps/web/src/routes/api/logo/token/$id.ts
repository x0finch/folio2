import { env } from "cloudflare:workers";
import { createFileRoute } from "@tanstack/react-router";
import { serveLogo } from "@/lib/server/logo";
import { buildTokens } from "@/lib/server/tokens";

// 公开(无 requireAuth)logo 代理:内部代币行 id → 经 tokens 拿上游图 → 透传 + 边缘缓存头。
// logo 是公共数据;公开才可被 Workers Cache 缓存(带鉴权请求会 bypass)。见 ADR 0008 / PRD #18。
export const Route = createFileRoute("/api/logo/token/$id")({
  server: {
    handlers: {
      GET: ({ params }: { params: { id: string } }) =>
        serveLogo(() => buildTokens(env).logoUrlById(params.id), "token", params.id),
    },
  },
});
