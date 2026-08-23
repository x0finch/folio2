import { getAuth } from "./auth";
import { resolveAuth } from "./auth-session";

// 路由 handler(非 server function)里取当前用户。
//
// server fn 走 `requireAuth` 中间件;那个是 `createMiddleware({type:"function"})`,
// 挂不到 `createFileRoute(...).server.handlers` 上,所以这里单独给一条。
// 与它同一条红线:**userId 只来自已验证 session,绝不来自客户端入参**。
//
// 无 session → 返回 undefined(而不是抛),让调用方自己决定给 401 还是给一个「什么都没有」——
// logo 端点选后者:那条路上「你没登录」和「这个 id 不是你的」应当无从区分。
export async function userIdOf(request: Request): Promise<string | undefined> {
  const result = await getAuth().api.getSession({ headers: request.headers });
  return result?.user.id;
}

// export / import / sync 等必须登录的端点:无 session → 401 Response(与 resolveAuth 同形)。
export async function requireUserId(request: Request): Promise<string | Response> {
  const session = await getAuth().api.getSession({ headers: request.headers });
  try {
    return resolveAuth(session).userId;
  } catch (err) {
    return err instanceof Response ? err : new Response("Unauthorized", { status: 401 });
  }
}
