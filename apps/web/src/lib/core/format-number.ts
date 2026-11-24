// formatNumber is for token amounts; formatMoney is currency-aware (symbol, placement, decimals).

import type { Currency } from "@folio/oracle-basic";

const SUBSCRIPTS = "₀₁₂₃₄₅₆₇₈₉";
const TINY_THRESHOLD = 0.01; // below this, subscript notation
const COMPACT_THRESHOLD = 100_000_000; // at or above this, M/B/T when compact
const DEFAULT_MAX_FRACTION_DIGITS = 2;
const CRYPTO_FRACTION_DIGITS = 8;

type NumberLike = number | bigint | string | null | undefined;

const toSubscript = (n: number): string =>
  String(n)
    .split("")
    .map((ch) => SUBSCRIPTS[Number(ch)])
    .join("");

// Subscript = count of leading zeros after the point, then two significant digits. Uses
// toExponential to avoid toFixed float noise (0.009 once rendered as 0.0₂89); rounding up past the
// threshold falls back to a plain decimal.
const formatTiny = (value: number): string => {
  const sign = value < 0 ? "-" : "";
  const [mantissa, expStr] = Math.abs(value).toExponential(1).split("e"); // e.g. "9.0", "-3"
  const exp = Number(expStr);

  const rounded = Number(`${mantissa}e${exp}`);
  if (rounded >= TINY_THRESHOLD) return `${sign}${rounded}`;

  const leadingZeros = -exp - 1; // 0.0090 (exp -3) → 2
  const digits = mantissa.replace(".", "").replace(/0+$/, "") || "0"; // "90" → "9"
  return `${sign}0.0${toSubscript(leadingZeros)}${digits}`;
};

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
 * `unit` is a prefix; the sign goes before it. maxFractionDigits applies to the regular and
 * compact branches only (the tiny branch always shows two significant digits).
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

  return `${value < 0 ? "-" : ""}${unit}${body}`;
};

const isTiny = (n: number): boolean =>
  Number.isFinite(n) && n !== 0 && Math.abs(n) < TINY_THRESHOLD;

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

// Intl alone would round 0.005 to $0.01; keep the locale's currency shell around a subscript body.
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
    if (p.type === "minusSign") continue; // we prepend our own sign
    shell += p.value;
  }
  return `${negative ? "-" : ""}${shell}`;
};

/**
 * Converts by `rate`, then fiat uses Intl currency style and crypto a `₿`/`Ξ` prefix with high
 * precision (never compact).
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
  // Auto-compact at ≥1e8 unless set; chart axes pass true for short labels.
  const useCompact = compact ?? Math.abs(converted) >= COMPACT_THRESHOLD;
  return currencyFormatter(locale, currency.code, useCompact).format(converted);
};

// Uses a true minus (U+2212); zero gets no sign. Every gain/loss display goes through here.
export function signedUsd(usd: (n: number) => string, v: number): string {
  return `${v > 0 ? "+" : v < 0 ? "−" : ""}${usd(Math.abs(v))}`;
}
