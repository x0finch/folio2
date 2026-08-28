// 纯 auth 逻辑,无任何 server-only import(故可被单测直接导入,也不会把
// cloudflare:workers / server headers 拖进客户端包)。取 session 由 require-auth.ts
// 的 requireAuth 中间件在 .server() 内完成,再把结果喂给这里校验。

export interface SessionResult {
  user: { id: string; [k: string]: unknown };
  session: { id: string; [k: string]: unknown };
}

// 把已取到的 session 结果转成 auth context;无 session → 抛 401 Response。
// 关键:userId 只来自已验证 session,绝不来自客户端入参。
//
// **只出 userId**(#504 T13)。以前它还带着 `user` 与 `session` 整份 —— 那是给 handler 的
// `{ data, context }` 签名准备的,而现在没有 handler 收 context:装配点(`runEffect` /
// `runForUser`)只读 userId,别的一个字段都不该在这条路上流动。要 user 详情的地方另有出口
//(`session/get.ts` 的 `getSession`,那是公开的、给路由守卫做 UX 判断用的)。
export function resolveAuth(result: SessionResult | null): { userId: string } {
  if (!result) {
    throw new Response("Unauthorized", { status: 401 });
  }
  return { userId: result.user.id };
}

// better-auth 的会话 cookie 名。两个都要认:baseURL 是 https 时它自己加 `__Secure-` 前缀
// (线上、e2e 的 https://localhost:3100),http 的本地 dev 则不加。前缀由 `cookiePrefix` 决定,
// 我们没改过 → 默认的 `better-auth`(见 ./auth 里的 betterAuth 配置)。
const SESSION_COOKIE_NAMES = [
  "better-auth.session_token",
  "__Secure-better-auth.session_token",
] as const;

// **只看这个 cookie 在不在**,不解密、不验签、不查库(ADR 0049)。
//
// 它是登录后路由整树 `ssr: false` 之后,唯一还留在服务端的那道「没登录就跳 /login」——
// `_authed.beforeLoad` 里那次真鉴权已经搬到浏览器了。判据这么弱是**故意的**:壳里零数据,
// 等同静态资源;伪造一个同名 cookie 只换来一张骨架,数据接口每一条都过 `requireAuth`
// (无 session → 401),真鉴权在浏览器里立刻把人踢回 /login。安全面没有变化,变的只是
// 「谁来渲染那张壳」。
//
// 名字必须**整段相等**:子串匹配会把 `better-auth.session_data`、passkey 的 challenge cookie,
// 乃至任何以它结尾的第三方 cookie 认成已登录 —— 那就等于这道门根本没关。
// 值为空也不算:登出正是把值置空过期。
export function hasSessionCookie(cookieHeader: string | null | undefined): boolean {
  if (!cookieHeader) return false;
  for (const part of cookieHeader.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    const name = part.slice(0, eq).trim();
    if (!SESSION_COOKIE_NAMES.some((n) => n === name)) continue;
    if (part.slice(eq + 1).trim().length > 0) return true;
  }
  return false;
}

// **`AuthContext` 这个类型没了**(#504 T12):它存在的唯一理由是给 handler 的
// `{ data, context }` 签名用,而现在没有 handler 收 context —— userId 由装配点
// (`runEffect` / `runForUser`)吃掉。要 context 形状的地方直接用 `ReturnType<typeof resolveAuth>`。
