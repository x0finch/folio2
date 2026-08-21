import { type Currency, DEFAULT_CURRENCY, SUPPORTED_CURRENCIES } from "@folio/oracle-basic";
import { createServerFn } from "@tanstack/react-start";
import { getRequestHeaders, getRequestUrl, setCookie } from "@tanstack/react-start/server";
import { z } from "zod";
import type { PreferCurrency } from "../../hooks/use-prefer-currency";
import { LOCALE_COOKIE, pickLocale, readLocaleCookie } from "../../i18n/detect";
import type { Locale } from "../../i18n/messages";
import { requireAuth } from "../session/require-auth";
import { displayRate } from "./fx";

// 展示币种偏好(每浏览器,仿 locale)。纯逻辑:cookie 解析 + 按 SUPPORTED 校验。
const CURRENCY_COOKIE = "folio_currency";

const BY_CODE = new Map(SUPPORTED_CURRENCIES.map((c) => [c.code, c]));
const FALLBACK = BY_CODE.get(DEFAULT_CURRENCY) as Currency;

// code → Currency 描述符;未知/缺失 → 默认 USD。
function resolveCurrency(code: string | undefined | null): Currency {
  return (code ? BY_CODE.get(code) : undefined) ?? FALLBACK;
}

// 从 Cookie 头取 folio_currency(不依赖运行时,纯解析)。
function readCurrencyCookie(cookieHeader: string | null | undefined): string | undefined {
  if (!cookieHeader) return undefined;
  for (const part of cookieHeader.split(";")) {
    const [k, ...rest] = part.trim().split("=");
    if (k === CURRENCY_COOKIE) return decodeURIComponent(rest.join("="));
  }
  return undefined;
}

// 展示偏好(币种 / 语言)—— 浏览器级偏好,存 cookie + 请求头,非账户数据。
// 语言那个仍是公开的;**币种那个改成了 authed**,理由见下。

// 服务端定展示币种:读 folio_currency cookie → SUPPORTED 校验 → 取该币种汇率。
// 取汇率的三档判断(USD / 缓存 / 冷缓存按需拉一次)在 ./fx 的 `displayRate` 里,
// 本 handler 只做壳:定币种 → 问汇率 → 套形状。**取不到就整体回退 USD** ——
// 币种是 EUR 而汇率却按 1 算会显示成错的数字,那比显示美元糟得多。
//
// **加了 requireAuth**(#202b):汇率搬进 per-user 缓存之后取汇率需要 userId。它本来也只被
// `_authed` 的 loader 调用(那里已经 beforeLoad 挡过没登录的),所以对外行为不变 ——
// 「币种偏好不敏感」这个判断仍然成立,只是拿汇率这件事现在需要知道是谁。
export const getCurrencyPreference = createServerFn({ method: "GET" })
  .middleware([requireAuth])
  .handler(async ({ context }): Promise<PreferCurrency> => {
    const headers = getRequestHeaders();
    const currency = resolveCurrency(readCurrencyCookie(headers.get("cookie")));
    const rate = await displayRate(context.userId, currency.code);
    return rate == null ? { currency: resolveCurrency("USD"), rate: 1 } : { currency, rate };
  });

// 服务端定 locale:读 folio_locale cookie + Accept-Language(纯逻辑在 detect.ts)。
// 无需鉴权(语言偏好非敏感);根路由 loader 调用 → SSR 首屏即正确语言。
export const getLocalePreference = createServerFn({ method: "GET" }).handler((): Locale => {
  const headers = getRequestHeaders();
  return pickLocale(readLocaleCookie(headers.get("cookie")), headers.get("accept-language"));
});

// ─── 写 ───────────────────────────────────────────────────────────────────────
//
// **偏好 cookie 在服务端写,客户端不碰 `document.cookie`。** 以前三个切换器各自
// `document.cookie = ...`,那样只设得上 `Path` 和 `Max-Age` —— `HttpOnly` 从定义上就设不了,
// `SameSite` / `Secure` 也一个都没写。搬到这里之后三样都能设,而且只有一处能设。
//
// **`HttpOnly` 在这里是白拿的**:这两个 cookie 没有任何客户端读者(`readCurrencyCookie` /
// `readLocaleCookie` 的调用点全在 `lib/server/` 下),前端要用值是走 `preferenceKeys` 那两条查询。
// 既然没人读,就该关掉脚本访问 —— 它顺带把「客户端偷偷写一下」这条路也堵死,与上面那条自洽。
//
// **鉴权按调用点分,不按「它敏不敏感」分**:语言切换器在登录页就要能用,所以 `setLocalePreference`
// 必须是公开的;而币种切换器只出现在认证区,读侧的 `getCurrencyPreference` 也带着 `requireAuth`,
// 那写侧就没理由敞着 —— 敞着等于凭空多一个无凭据就能改别人显示状态的跨站 POST 目标。
//
// 一年:偏好没有「过期」这回事,续期靠用户下次再切;比 session 长得多,又不是永不过期。
const PREFERENCE_COOKIE_MAX_AGE_SECONDS = 60 * 60 * 24 * 365;

function writePreferenceCookie(name: string, value: string): void {
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

// 写完不回传新值:调用点照旧走 `invalidateFor`,由那张映射表决定刷哪些读(ADR 0038)。
// 代价是这一次切换会多一个请求(写一次 + 读一次),换来的是失效语义仍然只有一个出处。

export const setCurrencyPreference = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .validator(z.object({ code: z.string() }))
  .handler(({ data }) => {
    // 落库前先过一遍 SUPPORTED:cookie 是用户可改的输入,别把垃圾写进去让读侧天天兜底。
    writePreferenceCookie(CURRENCY_COOKIE, resolveCurrency(data.code).code);
  });

export const setLocalePreference = createServerFn({ method: "POST" })
  .validator(z.object({ locale: z.string() }))
  .handler(({ data }) => {
    // 同上:`pickLocale` 认不出来就落默认,写进去的一定是合法 locale。
    writePreferenceCookie(LOCALE_COOKIE, pickLocale(data.locale, null));
  });
