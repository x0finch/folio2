import { createServerFn } from "@tanstack/react-start";
import { getRequestHeaders } from "@tanstack/react-start/server";
import { readCurrencyCookie, resolveCurrency } from "../currency";
import type { PreferCurrency } from "../hooks/use-prefer-currency";
import { pickLocale, readLocaleCookie } from "../i18n/detect";
import type { Locale } from "../i18n/messages";
import { oracle } from "./oracle";

// 展示偏好(币种 / 语言)—— 浏览器级偏好,存 cookie + 请求头,非账户数据 → 公开 server fn(无需 auth)。

// 服务端定展示币种:读 folio_currency cookie → SUPPORTED 校验 → 取该币种汇率。
// 冷缓存(尚未 sync 预热)→ 按需 warm 一次(exchange_rates 一次拉全),让首次切换即生效,
// 不必先同步。仍缺(未收录/离线)/异常 → 回退 USD(rate=1),绝不让认证区加载失败或空白。
export const getCurrencyPreference = createServerFn({ method: "GET" }).handler(
  async (): Promise<PreferCurrency> => {
    const headers = getRequestHeaders();
    const currency = resolveCurrency(readCurrencyCookie(headers.get("cookie")));
    if (currency.code === "USD") return { currency, rate: 1 };
    const fx = oracle.fx;
    let rate: number | undefined;
    try {
      rate = await fx.resolve(currency.code);
      if (rate == null) {
        await fx.warm([currency.code]); // 冷缓存 → 按需拉一次
        rate = await fx.resolve(currency.code);
      }
    } catch {
      rate = undefined;
    }
    return rate == null ? { currency: resolveCurrency("USD"), rate: 1 } : { currency, rate };
  },
);

// 服务端定 locale:读 folio_locale cookie + Accept-Language(纯逻辑在 detect.ts)。
// 无需鉴权(语言偏好非敏感);根路由 loader 调用 → SSR 首屏即正确语言。
export const getLocalePreference = createServerFn({ method: "GET" }).handler((): Locale => {
  const headers = getRequestHeaders();
  return pickLocale(readLocaleCookie(headers.get("cookie")), headers.get("accept-language"));
});
