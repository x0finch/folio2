import { getRequestUrl, setCookie } from "@tanstack/react-start/server";

// **偏好 cookie 在服务端写,客户端不碰 `document.cookie`。** 以前三个切换器各自
// `document.cookie = ...`,那样只设得上 `Path` 和 `Max-Age` —— `HttpOnly` 从定义上就设不了,
// `SameSite` / `Secure` 也一个都没写。搬到这里之后三样都能设,而且只有一处能设。
//
// **`HttpOnly` 在这里是白拿的**:这两个 cookie 没有任何客户端读者(`readCurrencyCookie` /
// `readLocaleCookie` 的调用点全在 `lib/server/` 下),前端要用值是走 `preferenceKeys` 那两条查询。
// 既然没人读,就该关掉脚本访问 —— 它顺带把「客户端偷偷写一下」这条路也堵死,与上面那条自洽。
//
// 一年:偏好没有「过期」这回事,续期靠用户下次再切;比 session 长得多,又不是永不过期。
const PREFERENCE_COOKIE_MAX_AGE_SECONDS = 60 * 60 * 24 * 365;

export function writePreferenceCookie(name: string, value: string): void {
  setCookie(name, value, {
    path: "/",
    maxAge: PREFERENCE_COOKIE_MAX_AGE_SECONDS,
    httpOnly: true,
    // Lax 而不是 Strict:从外链跳进来时偏好该保住,而这两个值没有任何 CSRF 价值。
    sameSite: "lax",
    // 按请求协议判断,不能写死 —— 本地 dev 是 http://localhost,硬加 Secure 会让 cookie 根本设不上。
    secure: getRequestUrl().protocol === "https:",
  });
}
