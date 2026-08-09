// 浏览器级偏好 cookie 的**写**入口。读侧各在各家(`currency.ts` 的 `readCurrencyCookie`、
// `i18n/detect.ts` 的 `readLocaleCookie`)—— 它们是纯解析、服务端也要用,不能碰 `document`。
//
// 收成一处的理由不是「少写两行」,是**写法必须和读法对称**:两个读侧都 `decodeURIComponent`,
// 而三个写侧原先都不编码。当前写进去的值(币种代号 / `en` / `zh`)编不编码结果一样,所以这不是
// 在修 bug;是把「以后塞了个带分号或中文的值」这条路提前堵上,免得只有一半的编解码。
//
// `max-age` 一年:偏好没有「过期」这回事,续期靠用户下次再切;比 session 长得多,又不是永不过期。
const PREFERENCE_COOKIE_MAX_AGE_SECONDS = 60 * 60 * 24 * 365;

// 规则(`noDocumentCookie`)推荐的 Cookie Store API 至今(2026-08)只有 Chromium 有,Safari / Firefox
// 都没落地,而这两个偏好是 SSR 首屏就要读到的,不能等。全 app 直接写 `document.cookie` 的地方就剩下面
// 那一行 —— 哪天 Cookie Store 普及了,改那一行就够。
export function writePreferenceCookie(name: string, value: string): void {
  // biome-ignore lint/suspicious/noDocumentCookie: Cookie Store API 浏览器支持还不够,见上
  document.cookie = `${name}=${encodeURIComponent(value)}; path=/; max-age=${PREFERENCE_COOKIE_MAX_AGE_SECONDS}`;
}
