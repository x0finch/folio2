import { describe, it } from "vitest";

// #527 · getCurrencyPreference / setCurrencyPreference / getLocalePreference / setLocalePreference
//
// **后续件 1 之后,这里只剩真正要请求上下文的那几条。** 四个 handler 的可测逻辑已经全部
// 拆成纯函数并各有单测(logic 组,毫秒级):
//
//   · 币种:cookie 解析 / SUPPORTED 校验 → `currency-detect.ts`,测在 `tests/currency-detect.test.ts`
//   · 语言:cookie 优先级 / accept-language 回落 → `lib/i18n/detect.ts`,测在 `tests/i18n.test.ts`(早就有)
//   · cookie 属性(HttpOnly / SameSite / Secure / 一年)→ `cookie-attributes.ts`,
//     测在 `tests/preference-cookie.test.ts` —— 清单那条「属性要断言」就此有了着落
//   · 取汇率的三档判断 → `preferences/fx.ts`,测在 `tests/server/fx.test.ts`(早就有,10 条)
//
// handler 本体只剩「读请求头 → 调纯函数 → setCookie」的一行转发,而那一行要 TanStack Start
// 的 server 入口 —— 这套 workers 配置刻意不加载应用 Worker(理由在 wrangler.test.jsonc)。
// 所以下面几条是**转发本身**的端到端确认,归 e2e / 真浏览器,不归这一层。
describe("cookie 偏好(仅剩转发的端到端确认)", () => {
  it.skip("设成 JPY → 下次读到 JPY(cookie 往返,要真请求;各半的逻辑已单测)", () => {});
  it.skip("locale 两个端点是公开的 —— 未登录能用(登录页语言切换器,e2e 里天天在走)", () => {});
  it.skip("币种读侧:cookie EUR + 汇率可得 → 返回 EUR;取不到 → 整体回退 USD(fx 半已测)", () => {});
});
