import { getRequestUrl, setCookie } from "@tanstack/react-start/server";
import { preferenceCookieAttributes } from "./cookie-attributes";

// **偏好 cookie 在服务端写,客户端不碰 `document.cookie`。** 以前三个切换器各自
// `document.cookie = ...`,那样只设得上 `Path` 和 `Max-Age` —— `HttpOnly` 从定义上就设不了,
// `SameSite` / `Secure` 也一个都没写。搬到这里之后三样都能设,而且只有一处能设。
//
// **`HttpOnly` 在这里是白拿的**:这两个 cookie 没有任何客户端读者(`readCurrencyCookie` /
// `readLocaleCookie` 的调用点全在 `lib/server/` 下),前端要用值是走 `preferenceKeys` 那两条查询。
// 既然没人读,就该关掉脚本访问 —— 它顺带把「客户端偷偷写一下」这条路也堵死,与上面那条自洽。
//
// 属性算在 ./cookie-attributes(纯函数,单测在那边);这里只剩「读协议 + 交给 setCookie」——
// 这两句都要请求上下文,本文件因此测不到,而它已经薄到没有可错的地方。
export function writePreferenceCookie(name: string, value: string): void {
  setCookie(name, value, preferenceCookieAttributes(getRequestUrl().protocol === "https:"));
}
