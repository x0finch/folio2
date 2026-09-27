// perf 用户的登录态:走 better-auth 的 HTTP 接口,和真浏览器、e2e(fixtures/app.ts)同一条路。
//
// 必须带 `Origin` —— better-auth 有 CSRF 校验,不带就 403。
// Cookie 直接从 `Set-Cookie` 头取(`getSetCookie()`),不经 curl 的 cookie jar:那份文件把
// HttpOnly cookie 写成 `#HttpOnly_` 开头的行,按「# 开头是注释」一过滤,会话就悄悄丢了,
// 之后每个请求都是 401 —— 最初那轮测量踩过。

/** Set-Cookie 列表 → 请求用的 `cookie` 头(只要 name=value,属性全丢)。 */
function cookieHeaderOf(res) {
  return res.headers
    .getSetCookie()
    .map((c) => c.split(";")[0])
    .join("; ");
}

async function post(origin, path, body) {
  return fetch(`${origin}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", origin },
    body: JSON.stringify(body),
  });
}

/** 注册 perf 用户(better-auth 开着 autoSignIn,注册即登录)。 */
export async function signUp(origin, user) {
  const res = await post(origin, "/api/auth/sign-up/email", user);
  if (!res.ok) throw new Error(`sign-up failed: ${res.status} ${await res.text()}`);
  return cookieHeaderOf(res);
}

/** 登录,返回 `cookie` 请求头的值。 */
export async function signIn(origin, { email, password }) {
  const res = await post(origin, "/api/auth/sign-in/email", { email, password });
  if (!res.ok) throw new Error(`sign-in failed: ${res.status} ${await res.text()}`);
  const cookie = cookieHeaderOf(res);
  if (!cookie) throw new Error("sign-in returned no session cookie");
  return cookie;
}
