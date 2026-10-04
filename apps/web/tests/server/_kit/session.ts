import { env } from "cloudflare:test";
import { getSessionAuth } from "@/lib/server/session/session-auth";

// **真登录一次,拿回 cookie。**
//
// 路由 handler(`/api/export` 等)认人走的是生产那条 `requireUserId` → better-auth `getSession`,
// 没有可换的服务。所以这里不伪造会话:经 better-auth 自己的路由注册一个用户,拿它回的
// Set-Cookie —— 与浏览器登录后带的是同一对 cookie,签名、会话行都是真的。
//
// 测试 Worker 的配置刻意只绑 DB(`wrangler.test.jsonc`),没有 better-auth 要的那两个变量;
// 实例是惰性建的,所以在第一次用之前补上即可。**这是一把测试用的假密钥**,与任何环境无关。
//
// 为什么走 `.handler(Request)` 而不是 `api.signUpEmail`:直接调 api 时 `tanstackStartCookies`
// 插件会去 import TanStack Start 的请求上下文,那个在这套 harness 里不存在;经路由调它会跳过。

const ORIGIN = "http://localhost:3000";

const ensureAuthEnv = () => {
  const e = env as unknown as Record<string, string | undefined>;
  e.BETTER_AUTH_URL ??= ORIGIN;
  e.BETTER_AUTH_SECRET ??= "test-only-better-auth-secret-0123456789abcdef";
};

export interface SignedIn {
  readonly userId: string;
  readonly cookie: string;
}

/** 注册(先删掉同 email 的旧用户 —— 级联清掉他的全部数据)并返回带会话的 cookie。 */
export const signUp = async (email: string): Promise<SignedIn> => {
  ensureAuthEnv();
  await env.DB.prepare("DELETE FROM user WHERE email = ?").bind(email).run();
  const res = await getSessionAuth().handler(
    new Request(`${ORIGIN}/api/auth/sign-up/email`, {
      method: "POST",
      headers: { origin: ORIGIN, "content-type": "application/json" },
      body: JSON.stringify({ email, password: "test-password-123", name: email }),
    }),
  );
  if (!res.ok) throw new Error(`sign-up failed: ${res.status} ${await res.text()}`);
  const body = (await res.json()) as { user: { id: string } };
  const cookie = res.headers
    .getSetCookie()
    .map((c) => c.split(";")[0])
    .join("; ");
  return { userId: body.user.id, cookie };
};

/** 一个打到 app 的请求;`as` 给了就带上那个人的 cookie。 */
export const appRequest = (path: string, init: RequestInit = {}, as?: SignedIn): Request => {
  ensureAuthEnv();
  const headers = new Headers(init.headers);
  if (as) headers.set("cookie", as.cookie);
  return new Request(`${ORIGIN}${path}`, { ...init, headers });
};
