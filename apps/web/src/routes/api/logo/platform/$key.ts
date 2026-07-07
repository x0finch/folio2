import { env } from "cloudflare:workers";
import { createFileRoute } from "@tanstack/react-router";
import { serveLogo } from "@/lib/server/logo";
import { buildPlatforms } from "@/lib/server/platforms";

// 公开(无 requireAuth)平台 logo 代理:platform key(如 chain:bitcoin,含 `:` → URL 编码为一段)
// → 经 platforms.resolve(cache-only)拿上游图 → 透传 + 边缘缓存头。见 ADR 0008 / #20。
export const Route = createFileRoute("/api/logo/platform/$key")({
  server: {
    handlers: {
      GET: ({ params }: { params: { key: string } }) =>
        serveLogo(
          async () => (await buildPlatforms(env).resolve([params.key])).get(params.key)?.logo,
          "platform",
          params.key,
        ),
    },
  },
});
