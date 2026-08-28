import { createIsomorphicFn } from "@tanstack/react-start";
import { getRequestHeaders } from "@tanstack/react-start/server";
import { hasSessionCookie } from "@/lib/server/session/auth-session";

// 「没登录 → 307 /login」这件事**留在服务端**,但搬到了根路由(ADR 0049)。
//
// 为什么必须搬:`_authed` 整树 `ssr: false` 之后,它那个 `beforeLoad`(真鉴权,一次 D1 往返)
// 在服务端根本不跑了 —— 留在原地等于把未登录访客的重定向也一并搬进浏览器,访客会先拿到一张壳
// 再被 JS 弹走。根路由是仍然在服务端跑的最后一层,判据换成「cookie 在不在」(见
// `hasSessionCookie`:不解密、不查库,微秒级)。
//
// `_authed.beforeLoad` 里那次真鉴权**一条没动**,只是现在只在浏览器里跑:伪 cookie 拿到的壳
// 是零数据的,进了浏览器立刻被踢回 /login。

// 服务端读请求头里的 cookie;客户端**恒为 true**。
//
// 客户端为什么不能真判:会话 cookie 是 HttpOnly(better-auth 的默认,也是我们要的),
// `document.cookie` 里根本看不见它 —— 真去读只会读到 false,于是每次客户端导航都把已登录的人
// 弹去 /login。客户端这条路上该说话的是 `_authed.beforeLoad` 的真鉴权,不是这里。
const sessionCookiePresent = createIsomorphicFn()
  .server(() => hasSessionCookie(getRequestHeaders().get("cookie")))
  .client(() => true);

// 这次导航落在登录后的那棵树里吗。
//
// 按 **routeId 判**而不是按路径名单判:路径名单要跟着新页面手工维护,漏一条的表现是「新页面
// 未登录也进得去」—— 一条不会有人报的 bug。matches 是路由器自己算出来的,新增 `_authed` 子路由
// 自动在内。
const AUTHED_ROUTE_ID = "/_authed";

/** 未登录访问登录后页面 → 该重定向。服务端为真判,客户端恒为 false(见上)。 */
export function needsLoginRedirect(matches: ReadonlyArray<{ routeId: string }>): boolean {
  return matches.some((m) => m.routeId === AUTHED_ROUTE_ID) && !sessionCookiePresent();
}
