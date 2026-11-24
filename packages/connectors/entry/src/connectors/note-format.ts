// Matches `n.toLocaleString("en-US", { maximumFractionDigits: N })` exactly, without Intl: the
// first Intl number format in an isolate initialises ICU (~15ms CPU) against a 10ms budget.
// Like ICU, rounds the shortest round-trip decimal (`String(n)`) half away from zero, not the binary
// value (`toFixed` gives 1.005 → 1.00; Intl gives 1.01). Tests compare against Intl.

/** Expands `String(x)` (x ≥ 0, possibly exponential) into integer and fraction digit strings. */
const splitDecimal = (x: number): { int: string; frac: string } => {
  const [mantissa, expPart] = String(x).split("e");
  const exp = expPart === undefined ? 0 : Number(expPart);
  const [intDigits, fracDigits = ""] = mantissa.split(".");
  const digits = intDigits + fracDigits;
  const point = intDigits.length + exp; // decimal point position within digits
  if (point <= 0) return { int: "0", frac: "0".repeat(-point) + digits };
  if (point >= digits.length) return { int: digits + "0".repeat(point - digits.length), frac: "" };
  return { int: digits.slice(0, point), frac: digits.slice(point) };
};

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

/** Up to 8 decimals (`1,234.5`, `0.00012345`). */
export const formatAmount = (n: number): string => formatMaxFraction(n, 8);

/** Up to 2 decimals, no sign or currency. */
export const formatCents = (n: number): string => formatMaxFraction(n, 2);

export const formatWhole = (n: number): string => formatMaxFraction(n, 0);
