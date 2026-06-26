import { createMiddleware } from "@tanstack/react-start";
import { getRequestHeaders } from "@tanstack/react-start/server";
import { getAuth } from "./auth";
import { resolveAuth } from "./auth-session";

// server function 守卫中间件:取 session 并把 userId 注入下游 context。
// getAuth / getRequestHeaders 只在此 .server() 回调内调用 → 客户端构建时整段被剥离,
// 不会把 cloudflare:workers / server headers 拖进客户端包。纯校验逻辑见 ./auth-session。
// 安全边界是 server function 本身(路由守卫只是 UX)——每个碰私有数据的 fn 都挂它。
export const requireAuth = createMiddleware({ type: "function" }).server(async ({ next }) => {
  const result = await getAuth().api.getSession({ headers: getRequestHeaders() });
  return next({ context: resolveAuth(result) });
});
