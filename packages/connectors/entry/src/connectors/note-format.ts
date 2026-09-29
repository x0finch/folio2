// note 文案里的数字格式(三家 CEX 的 parse 共用):en-US 千分位 + 最多 N 位小数,
// 与 `n.toLocaleString("en-US", { maximumFractionDigits: N })` **逐字相同**。
//
// **为什么不直接用 `toLocaleString` / `Intl.NumberFormat`**(FOL-83 第二轮):一个 isolate 里
// 第一次用到 Intl 的数字格式要先把 ICU 那一套初始化起来 —— Node 上实测 ≈15ms CPU,jobs 的
// profile 里是一次币安同步里的 ≈19ms(一共才格式化六七个数)。免费计划一次调用只有 10ms,而队列
// consumer 常落在新 isolate 上,所以这笔账几乎每条交易所的 `sync-account` 都要付一次。
// 这几个格式要的只是「十进制四舍五入 + 千分位」,手写几十行就够,不值得为它拉起 ICU。
//
// **怎么保证与 Intl 一致**:ICU 格式化一个 double 时取的是它的**最短十进制表示**(与 `String(n)`
// 同一套 shortest round-trip 算法),再按 halfExpand(0.5 远离零进位)舍到 N 位 —— 所以这里也从
// `String(|n|)` 的数字串出发做十进制舍入,不走 `toFixed`(它按二进制精确值舍,`1.005` 会得
// `1.00`,Intl 给 `1.01`)。负数(含 `-0`、以及舍成 0 的负数)保留负号,与 Intl 一样。
// `note-format.test.ts` 拿 Intl 当对照,逐个比一大批数(随机量级、舍入的边界、整数、负数)。

/** 把 `String(x)`(x ≥ 0,可能带指数)展开成「整数部分数字串 + 小数部分数字串」。 */
const splitDecimal = (x: number): { int: string; frac: string } => {
  const [mantissa, expPart] = String(x).split("e");
  const exp = expPart === undefined ? 0 : Number(expPart);
  const [intDigits, fracDigits = ""] = mantissa.split(".");
  const digits = intDigits + fracDigits;
  const point = intDigits.length + exp; // 小数点在 digits 里的位置
  if (point <= 0) return { int: "0", frac: "0".repeat(-point) + digits };
  if (point >= digits.length) return { int: digits + "0".repeat(point - digits.length), frac: "" };
  return { int: digits.slice(0, point), frac: digits.slice(point) };
};

/** 数字串 +1(个位进位,可能多出一位)。 */
const incrementDigits = (s: string): string => {
  const out = s.split("");
  for (let i = out.length - 1; i >= 0; i--) {
    if (out[i] !== "9") {
      out[i] = String(Number(out[i]) + 1);
      return out.join("");
    }
    out[i] = "0";
  }
  return `1${out.join("")}`;
};

const groupThousands = (int: string): string => int.replace(/\B(?=(\d{3})+(?!\d))/g, ",");

const formatMaxFraction = (n: number, maxFrac: number): string => {
  if (Number.isNaN(n)) return "NaN";
  const negative = n < 0 || Object.is(n, -0);
  if (!Number.isFinite(n)) return negative ? "-∞" : "∞";
  let { int, frac } = splitDecimal(Math.abs(n));
  if (frac.length > maxFrac) {
    const roundUp = frac.charCodeAt(maxFrac) >= 53; // '5'..'9' → halfExpand
    frac = frac.slice(0, maxFrac);
    if (roundUp) {
      const bumped = incrementDigits(int + frac);
      int = bumped.slice(0, bumped.length - maxFrac);
      frac = bumped.slice(bumped.length - maxFrac);
    }
  }
  frac = frac.replace(/0+$/, "");
  int = int.replace(/^0+(?=\d)/, "");
  const body = frac ? `${groupThousands(int)}.${frac}` : groupThousands(int);
  return negative ? `-${body}` : body;
};

/** 原币数量:千分位,最多 8 位小数(`1,234.5`、`0.00012345`)。 */
export const formatAmount = (n: number): string => formatMaxFraction(n, 8);

/** 千分位,最多 2 位小数(不带符号 / 币种 —— 调用方自己拼)。 */
export const formatCents = (n: number): string => formatMaxFraction(n, 2);

/** 千分位,整数。 */
export const formatWhole = (n: number): string => formatMaxFraction(n, 0);
