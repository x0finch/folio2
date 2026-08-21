import { getLogger, withContext } from "@logtape/logtape";
import { createMiddleware } from "@tanstack/react-start";
import { getRequestHeaders } from "@tanstack/react-start/server";
import { getAuth } from "./auth";
import { resolveAuth } from "./auth-session";

const log = getLogger(["folio", "web", "server-fn"]);

// server function 守卫中间件:取 session 并把 userId 注入下游 context。
// getAuth / getRequestHeaders 只在此 .server() 回调内调用 → 客户端构建时整段被剥离,
// 不会把 cloudflare:workers / server headers 拖进客户端包。纯校验逻辑见 ./auth-session。
// 安全边界是 server function 本身(路由守卫只是 UX)——每个碰私有数据的 fn 都挂它。
// withContext({userId}) 包住下游 handler:其内所有日志(LogTape getLogger)经 ALS 自动带上 userId(P6.7)。
// 同时在此集中兜底 server fn 抛错:handler 不必各自 try/catch —— 任何未捕获错误都在这里带 userId 打日志再上抛
// (否则 TanStack 只把错误序列化给客户端、服务端不打印,根因无处可见)。
export const requireAuth = createMiddleware({ type: "function" }).server(async ({ next }) => {
  const auth = resolveAuth(await getAuth().api.getSession({ headers: getRequestHeaders() }));
  return withContext({ userId: auth.userId }, async () => {
    try {
      return await next({ context: auth });
    } catch (err) {
      log.error("server fn threw", {
        error: err instanceof Error ? err.message : String(err),
        code: (err as { code?: string })?.code,
      });
      throw err;
    }
  });
});
