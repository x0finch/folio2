import { type Currency, DEFAULT_CURRENCY, SUPPORTED_CURRENCIES } from "@folio/oracle2-basic";

// 展示币种偏好(每浏览器,仿 locale)。纯逻辑:cookie 解析 + 按 SUPPORTED 校验。
export const CURRENCY_COOKIE = "folio_currency";

const BY_CODE = new Map(SUPPORTED_CURRENCIES.map((c) => [c.code, c]));
const FALLBACK = BY_CODE.get(DEFAULT_CURRENCY) as Currency;

// code → Currency 描述符;未知/缺失 → 默认 USD。
export function resolveCurrency(code: string | undefined | null): Currency {
  return (code ? BY_CODE.get(code) : undefined) ?? FALLBACK;
}

// 从 Cookie 头取 folio_currency(不依赖运行时,纯解析)。
export function readCurrencyCookie(cookieHeader: string | null | undefined): string | undefined {
  if (!cookieHeader) return undefined;
  for (const part of cookieHeader.split(";")) {
    const [k, ...rest] = part.trim().split("=");
    if (k === CURRENCY_COOKIE) return decodeURIComponent(rest.join("="));
  }
  return undefined;
}
