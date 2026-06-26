import { createMiddleware } from "@tanstack/react-start";
import { getRequestHeaders } from "@tanstack/react-start/server";
import { getAuth } from "./auth";

// 守卫核心抽成纯函数,便于单测(mock getSession),也供路由/server fn 复用。
// 无 session → 抛 401 Response(数据调用语义;路由跳转 redirect 留 P2.5)。
// 关键:userId 只来自已验证 session,绝不来自客户端入参。
export async function resolveAuth() {
  const result = await getAuth().api.getSession({ headers: getRequestHeaders() });
  if (!result) {
    throw new Response("Unauthorized", { status: 401 });
  }
  return { userId: result.user.id, user: result.user, session: result.session };
}

// server function 守卫中间件:校验 session 并把 userId 注入下游 context。
// 安全边界是 server function 本身(路由守卫只是 UX)——每个碰私有数据的 fn 都挂它。
export const requireAuth = createMiddleware({ type: "function" }).server(async ({ next }) => {
  return next({ context: await resolveAuth() });
});
