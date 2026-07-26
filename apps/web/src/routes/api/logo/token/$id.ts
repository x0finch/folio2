import { createFileRoute } from "@tanstack/react-router";
import { serveLogo } from "@/lib/server/internal/logo";
import { oracleFor } from "@/lib/server/internal/oracle2";
import { userIdOf } from "@/lib/server/internal/route-auth";

// 代币 logo 代理:内部代币行 id → 经该用户的参考层拿上游图 → 透传 + 缓存头。见 ADR 0008 / PRD #18。
//
// **按用户收口**(#201):代币表转 per-user 之后,id 是某个用户私有的行 —— 拿到别人的 id
// 也取不到别人的图(`oracleFor(userId)` 的 store 只看得见自己那些行)。
// 未登录 / 不是自己的 id 一律走同一条「没有这张图」的路,两者无从区分。
//
// 代价是**边缘缓存没了**(带 Cookie 的请求 Workers Cache 会 bypass):ADR 0008 当初选公开正是
// 为了让它能被边缘缓存住。改成 `private` 之后浏览器仍会缓存 1 天,只是每个用户第一次要回源一趟。
// 这笔账认了 —— 图是公共数据,但「这个 id 存不存在」不是。
export const Route = createFileRoute("/api/logo/token/$id")({
  server: {
    handlers: {
      GET: async ({ params, request }: { params: { id: string }; request: Request }) => {
        const userId = await userIdOf(request);
        return serveLogo(
          async () => (userId ? oracleFor(userId).tokens.logoUrlById(params.id) : undefined),
          "token",
          params.id,
          { private: true },
        );
      },
    },
  },
});
