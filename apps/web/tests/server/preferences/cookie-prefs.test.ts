import { describe, it } from "vitest";

// #527 · getCurrencyPreference / setCurrencyPreference / getLocalePreference / setLocalePreference
//
// **四个都在这套 harness 里 import 不进来。** 实测(一次性探针,跑完删了):
// `@/lib/server/preferences/currency` 与 `.../locale` 都报
// `Missing "#tanstack-router-entry" specifier in "@tanstack/start-server-core"`。
//
// 成因:它们经 `getRequestHeaders()` / `writePreferenceCookie()` 拉进 TanStack Start 的 server
// 入口,而那个入口只在应用 Worker 里存在;这套配置刻意只绑 DB(见 `wrangler.test.jsonc`)。
// 与 `getSession` 是同一道墙,不是缺夹具。
//
// **这四个恰好也是清单里「完全没有测试」的那批**,所以这堵墙不是小事 —— 它解释了为什么它们一直
// 没有测试:不是没人写,是这一层写不了。三条出路,按代价从低到高:
//
//   ① 把 cookie 的读写抽成不碰请求上下文的纯函数(读:`(cookieHeader, acceptLanguage) => Locale`;
//      写:`(name, value) => SetCookieString`),handler 只剩一行转发。那两个纯函数在 `tests/`
//      的 logic 组里随手可测,连 D1 都不要。**这是我建议的做法** —— 它同时解决了「cookie 属性
//      要断言」那条:属性变成返回值的一部分,而不是一次副作用。
//   ② 给这套 workers 配置加载应用 Worker。能测,但把其余 53 个 handler 的启动开销一起抬上去。
//   ③ 只在 e2e 覆盖。语言切换在 e2e 里点得到,但「cookie 的 SameSite 对不对」在浏览器里断言不了。
//
// 挂起的具体用例(清单原文,规则不变,只是落点要先定):
describe("cookie 偏好(currency / locale)", () => {
  it.skip("cookie 里是 EUR → 返回 EUR 和它的汇率(要请求上下文)", () => {});
  it.skip("没有 cookie → 返回默认币种(同上)", () => {});
  it.skip("cookie 里是不支持的币种 → 回落默认而不是报错(同上)", () => {});
  it.skip("汇率取不到 → 币种照旧返回,汇率标成缺(同上)", () => {});
  it.skip("设成 JPY → 下次读到 JPY(同上)", () => {});
  it.skip("设一个不支持的币种 → 拒,cookie 不动(同上)", () => {});
  it.skip("写 cookie 的属性要断言(SameSite / 路径 / HttpOnly),不只断言值(同上)", () => {});
  it.skip("cookie 有 zh → 返回 zh;没 cookie 但 accept-language 是 ja → 返回 ja(同上)", () => {});
  it.skip("cookie 与 accept-language 冲突 → cookie 赢(用户明确选过)(同上)", () => {});
  it.skip("accept-language 是没听过的 tag → 回落默认(同上)", () => {});
  it.skip("locale 两个端点是公开的 —— 未登录也必须能用(同上)", () => {});
});
