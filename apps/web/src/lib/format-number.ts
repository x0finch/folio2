// 数字格式化。两个入口:
//   · formatNumber —— 代币「数量」(移植/修复自 folio-old/lib/numbers.ts:紧凑 ≥1e8、≤2 位、下标 <0.01、bigint、负号)。
//   · formatMoney  —— 「货币」金额:换算(value/rate)后 fiat 走 Intl currency style、crypto 走 ₿/Ξ 前缀高精度(见 ADR 0006)。
// 数量 vs 货币分开:货币需 currency-aware 格式(符号/位置/小数位随币种),数量是纯量。

import type { Currency } from "@folio/oracle-basic";

const SUBSCRIPTS = "₀₁₂₃₄₅₆₇₈₉";
const TINY_THRESHOLD = 0.01; // 低于此用下标记法
const COMPACT_THRESHOLD = 100_000_000; // 1e8,不低于此且 compact 用 M/B/T
const DEFAULT_MAX_FRACTION_DIGITS = 2;
const CRYPTO_FRACTION_DIGITS = 8; // 加密展示币种(BTC/ETH)的最多小数位

type NumberLike = number | bigint | string | null | undefined;

const toSubscript = (n: number): string =>
  String(n)
    .split("")
    .map((ch) => SUBSCRIPTS[Number(ch)])
    .join("");

// 下标记法渲染极小数(0 < |n| < 0.01):下标 = 小数点后前导零个数,其后两位有效数字(四舍五入)。
// 用 toExponential 取两位有效数字与指数,避免 toFixed 的二进制浮点噪声(如 0.009 曾误得 0.0₂89)。
// 进位越过阈值(0.00999 → 0.01)则回退普通小数。
const formatTiny = (value: number): string => {
  const sign = value < 0 ? "-" : "";
  const [mantissa, expStr] = Math.abs(value).toExponential(1).split("e"); // 两位有效:如 "9.0","-3"
  const exp = Number(expStr);

  const rounded = Number(`${mantissa}e${exp}`);
  if (rounded >= TINY_THRESHOLD) return `${sign}${rounded}`; // 进位越界 → 回退普通小数

  const leadingZeros = -exp - 1; // 0.0090(exp -3)→ 2 个前导零
  const digits = mantissa.replace(".", "").replace(/0+$/, "") || "0"; // 有效数字去尾零:"90"→"9"
  return `${sign}0.0${toSubscript(leadingZeros)}${digits}`;
};

// locale + notation + 小数位 缓存的 Intl formatter(与 use-intl 同源,避免每次 new)。
const formatters = new Map<string, Intl.NumberFormat>();
const getFormatter = (
  locale: string,
  compact: boolean,
  maxFractionDigits: number,
): Intl.NumberFormat => {
  const key = `${locale}|${compact ? "c" : "s"}|${maxFractionDigits}`;
  let f = formatters.get(key);
  if (!f) {
    f = new Intl.NumberFormat(locale, {
      maximumFractionDigits: maxFractionDigits,
      ...(compact ? { notation: "compact", compactDisplay: "short" } : {}),
    });
    formatters.set(key, f);
  }
  return f;
};

/**
 * 数字格式化的唯一入口。unit 作前缀(货币符号等),负号在最前;compact 默认开(≥1e8 用 M/B/T)。
 * maxFractionDigits 对常规/紧凑分支生效(下标分支恒两位有效数字);locale 决定分隔符与紧凑记法本地化。
 */
export const formatNumber = (
  value: NumberLike,
  options: Partial<{
    unit: string;
    compact: boolean;
    locale: string;
    maxFractionDigits: number;
  }> = {},
): string => {
  if (value == null || value === "") return "-";
  if (typeof value === "string") return formatNumber(Number(value), options);
  if (typeof value === "bigint") return formatNumber(Number(value), options);
  if (!Number.isFinite(value)) return "-"; // NaN / ±Infinity

  const {
    unit = "",
    compact = true,
    locale = "en-US",
    maxFractionDigits = DEFAULT_MAX_FRACTION_DIGITS,
  } = options;
  const n = Math.abs(value);

  let body: string;
  if (compact && n >= COMPACT_THRESHOLD) {
    body = getFormatter(locale, true, maxFractionDigits).format(n);
  } else if (n >= TINY_THRESHOLD) {
    body = getFormatter(locale, false, maxFractionDigits).format(n);
  } else if (n > 0) {
    body = formatTiny(n);
  } else {
    body = "0";
  }

  // 负号在最前(unit 之前),unit 未传时也不会污染输出(修复旧版 "-undefined")。
  return `${value < 0 ? "-" : ""}${unit}${body}`;
};

const isTiny = (n: number): boolean =>
  Number.isFinite(n) && n !== 0 && Math.abs(n) < TINY_THRESHOLD;

// locale+currency+compact 缓存的货币 formatter(Intl currency style)。
const currencyFormatters = new Map<string, Intl.NumberFormat>();
const currencyFormatter = (
  locale: string,
  currency: string,
  compact: boolean,
): Intl.NumberFormat => {
  const key = `${locale}|${currency}|${compact ? "c" : "s"}`;
  let f = currencyFormatters.get(key);
  if (!f) {
    f = new Intl.NumberFormat(locale, {
      style: "currency",
      currency,
      ...(compact
        ? { notation: "compact", compactDisplay: "short", maximumFractionDigits: 2 }
        : {}),
    });
    currencyFormatters.set(key, f);
  }
  return f;
};

// 极小法币值:取 Intl 货币外壳,把数字部分替换成下标 body(裸 Intl 会把 0.005 舍成 $0.01 丢信息)。
const formatTinyCurrency = (
  value: number,
  { locale = "en-US", currency = "USD" }: Partial<{ locale: string; currency: string }> = {},
): string => {
  const negative = value < 0;
  const body = formatTiny(Math.abs(value));
  const parts = new Intl.NumberFormat(locale, { style: "currency", currency }).formatToParts(0);
  const NUMERIC = new Set(["integer", "group", "decimal", "fraction"]);
  let emitted = false;
  let shell = "";
  for (const p of parts) {
    if (NUMERIC.has(p.type)) {
      if (!emitted) {
        shell += body;
        emitted = true;
      }
      continue;
    }
    if (p.type === "minusSign") continue; // 用 abs + 自己的符号
    shell += p.value; // 货币符号、literal 空格等(跟随 locale)
  }
  return `${negative ? "-" : ""}${shell}`;
};

/**
 * 货币金额展示。换算(value / rate)后按 currency.kind 分支:
 *   · fiat  → Intl currency style(符号/位置/小数位随币种+locale;≥1e8 紧凑);极小值走 formatTinyCurrency。
 *   · crypto→ `₿`/`Ξ` 前缀 + 高精度数字(复用 formatNumber:千分位/去尾零/极小值下标;不 compact)。
 */
export const formatMoney = (
  value: number,
  {
    rate = 1,
    locale = "en-US",
    currency,
    compact,
  }: { rate?: number; locale?: string; currency: Currency; compact?: boolean },
): string => {
  const converted = value / rate;

  if (currency.kind === "crypto") {
    const sym = currency.symbol ?? currency.code;
    const body = formatNumber(Math.abs(converted), {
      compact: false,
      maxFractionDigits: CRYPTO_FRACTION_DIGITS,
    });
    return `${converted < 0 ? "-" : ""}${sym}${body}`;
  }

  if (isTiny(converted)) return formatTinyCurrency(converted, { locale, currency: currency.code });
  // compact 未显式给时,≥1e8 自动紧凑;图表轴可显式传 true 缩短标签。
  const useCompact = compact ?? Math.abs(converted) >= COMPACT_THRESHOLD;
  return currencyFormatter(locale, currency.code, useCompact).format(converted);
};
