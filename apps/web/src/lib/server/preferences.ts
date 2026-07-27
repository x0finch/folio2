import { createServerFn } from "@tanstack/react-start";
import { getRequestHeaders } from "@tanstack/react-start/server";
import { readCurrencyCookie, resolveCurrency } from "../currency";
import type { PreferCurrency } from "../hooks/use-prefer-currency";
import { pickLocale, readLocaleCookie } from "../i18n/detect";
import type { Locale } from "../i18n/messages";
import { displayRate } from "./internal/fx";
import { requireAuth } from "./internal/require-auth";

// 展示偏好(币种 / 语言)—— 浏览器级偏好,存 cookie + 请求头,非账户数据。
// 语言那个仍是公开的;**币种那个改成了 authed**,理由见下。

// 服务端定展示币种:读 folio_currency cookie → SUPPORTED 校验 → 取该币种汇率。
// 取汇率的三档判断(USD / 缓存 / 冷缓存按需拉一次)在 ./internal/fx 的 `displayRate` 里,
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
