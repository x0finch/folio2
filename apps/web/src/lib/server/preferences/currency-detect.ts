import { type Currency, DEFAULT_CURRENCY, SUPPORTED_CURRENCIES } from "@folio/oracle-basic";

// 币种偏好的**纯逻辑半**(#527 后续件 1):cookie 解析 + SUPPORTED 校验,不碰任何运行时。
//
// 它从 currency.ts 里拆出来,为的是能测:那个文件 import TanStack Start 的 server 入口,
// 在 workers-pool 里 **import 那一步就失败**,于是这两个函数写在里面就是测不到的。
// 与 locale 那边的 `lib/i18n/detect.ts` 是同一个形状 —— 那份一直有测试,这份一直没有。
export const CURRENCY_COOKIE = "folio_currency";

const BY_CODE = new Map(SUPPORTED_CURRENCIES.map((c) => [c.code, c]));
const FALLBACK = BY_CODE.get(DEFAULT_CURRENCY) as Currency;

/** code → Currency 描述符;未知 / 缺失 → 默认(USD)。cookie 是用户可改的输入,垃圾在这儿拦。 */
export function resolveCurrency(code: string | undefined | null): Currency {
  return (code ? BY_CODE.get(code) : undefined) ?? FALLBACK;
}

/** 从 Cookie 头取 folio_currency(纯解析,不依赖运行时)。 */
export function readCurrencyCookie(cookieHeader: string | null | undefined): string | undefined {
  if (!cookieHeader) return undefined;
  for (const part of cookieHeader.split(";")) {
    const [k, ...rest] = part.trim().split("=");
    if (k === CURRENCY_COOKIE) return decodeURIComponent(rest.join("="));
  }
  return undefined;
}
