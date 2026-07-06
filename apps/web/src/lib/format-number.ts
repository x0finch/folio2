// 数字格式化(移植并修复自 folio-old/lib/numbers.ts)。对外只暴露一个 formatNumber:
//   · |n| ≥ 1e8 且 compact → 紧凑记法(123.46M / 1.5B / 1T)
//   · 0.01 ≤ |n| < 1e8      → 千分位 + 最多 maxFractionDigits 位小数(去尾零)
//   · 0 < |n| < 0.01        → 下标记法(0.0₄46)
//   · 0                      → "0"
//   · null / undefined / "" / NaN / ±Infinity → "-"
// 展示规则与 folio-old 一致(平替);实现做了修复与精简:负号(旧版负数无 unit 产出 "-undefined")、
// 下标有效位改四舍五入(旧版 slice 截断)、bigint、去掉 SmallNumberFormatter 类改纯函数、跟随 locale。
// 货币 = formatNumber(value, { unit }) 的薄封装(见 useDisplayValue,额外做汇率换算);数量 = formatNumber(n)。

const SUBSCRIPTS = "₀₁₂₃₄₅₆₇₈₉";
const TINY_THRESHOLD = 0.01; // 低于此用下标记法
const COMPACT_THRESHOLD = 100_000_000; // 1e8,不低于此且 compact 用 M/B/T
const DEFAULT_MAX_FRACTION_DIGITS = 2;

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
