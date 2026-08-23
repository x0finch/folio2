import { getLogger, withContext } from "@logtape/logtape";
import { createMiddleware } from "@tanstack/react-start";
import { getRequestHeaders } from "@tanstack/react-start/server";
import { Cause, Runtime } from "effect";
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
        error: describe(err),
        code: (err as { code?: string })?.code,
      });
      throw err;
    }
  });
});

// **兜底日志里要能看出「是哪个 handler、失败在哪一层」。**
//
// `runEffect` 跑完抛出的是 `FiberFailure`,它的 `message` 只有最外那一句 —— handler 名、调用链、
// 中断/并行那些结构全在它包着的 `Cause` 里。只打 message 的话,`Effect.fn("createTabPin")` 加的
// 那个名字一路走到这里正好被丢掉,等于白加(#504 T6)。
//
// 所以:是 `FiberFailure` 就打 `Cause.pretty`(带 span 栈:`at createTabPin (…)`),
// 别的照旧打 message。userId 由外面那层 `withContext` 自动带上,不必在这里拼。
const describe = (err: unknown): string => {
  if (Runtime.isFiberFailure(err)) return Cause.pretty(err[Runtime.FiberFailureCauseId]);
  return err instanceof Error ? err.message : String(err);
};
