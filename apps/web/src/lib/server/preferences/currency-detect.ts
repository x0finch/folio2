import { type Currency, DEFAULT_CURRENCY, SUPPORTED_CURRENCIES } from "@folio/oracle-basic";

// 币种偏好的**纯逻辑半**:SUPPORTED 校验,不碰任何运行时(单测在 tests/currency-detect.test.ts)。
const BY_CODE = new Map(SUPPORTED_CURRENCIES.map((c) => [c.code, c]));
const FALLBACK = BY_CODE.get(DEFAULT_CURRENCY) as Currency;

/** code → Currency 描述符;未知 / 缺失 → 默认(USD)。码是调用方可改的输入,垃圾在这儿拦。 */
export function resolveCurrency(code: string | undefined | null): Currency {
  return (code ? BY_CODE.get(code) : undefined) ?? FALLBACK;
}
