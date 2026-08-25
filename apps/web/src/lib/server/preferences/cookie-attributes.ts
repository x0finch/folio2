// 偏好 cookie 的**属性半**(#527 后续件 1):属性作为返回值,而不是一次观测不到的副作用。
//
// 为什么单拆一个文件:写 cookie 那句(`setCookie`)要 TanStack 的请求上下文,测不到;
// 而「SameSite 是不是 Lax、HttpOnly 有没有开、Secure 跟不跟协议走」恰恰是清单里点名要断言的
// 那几样。把属性算成一个纯对象,断言就落在这儿;cookie.ts 只剩「把这个对象交给 setCookie」。

// 一年:偏好没有「过期」这回事,续期靠用户下次再切;比 session 长得多,又不是永不过期。
const PREFERENCE_COOKIE_MAX_AGE_SECONDS = 60 * 60 * 24 * 365;

export interface PreferenceCookieAttributes {
  readonly path: "/";
  readonly maxAge: number;
  readonly httpOnly: true;
  readonly sameSite: "lax";
  readonly secure: boolean;
}

export function preferenceCookieAttributes(isHttps: boolean): PreferenceCookieAttributes {
  return {
    path: "/",
    maxAge: PREFERENCE_COOKIE_MAX_AGE_SECONDS,
    // 没有任何客户端读者(前端拿值走 preferenceKeys 那两条查询)→ 关掉脚本访问,
    // 顺带堵死「客户端偷偷写一下」那条路。
    httpOnly: true,
    // Lax 而不是 Strict:从外链跳进来时偏好该保住,而这两个值没有任何 CSRF 价值。
    sameSite: "lax",
    // 按请求协议判断,不能写死 —— 本地 dev 是 http://localhost,硬加 Secure 会让 cookie 根本设不上。
    secure: isHttps,
  };
}
