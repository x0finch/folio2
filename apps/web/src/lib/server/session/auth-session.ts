// 纯 auth 逻辑,无任何 server-only import(故可被单测直接导入,也不会把
// cloudflare:workers / server headers 拖进客户端包)。取 session 由 require-auth.ts
// 的 requireAuth 中间件在 .server() 内完成,再把结果喂给这里校验。

export interface SessionResult {
  user: { id: string; [k: string]: unknown };
  session: { id: string; [k: string]: unknown };
}

// 把已取到的 session 结果转成 auth context;无 session → 抛 401 Response。
// 关键:userId 只来自已验证 session,绝不来自客户端入参。
export function resolveAuth(result: SessionResult | null) {
  if (!result) {
    throw new Response("Unauthorized", { status: 401 });
  }
  return { userId: result.user.id, user: result.user, session: result.session };
}

// **`AuthContext` 这个类型没了**(#504 T12):它存在的唯一理由是给 handler 的
// `{ data, context }` 签名用,而现在没有 handler 收 context —— userId 由装配点
// (`runEffect` / `runForUser`)吃掉。要 context 形状的地方直接用 `ReturnType<typeof resolveAuth>`。
