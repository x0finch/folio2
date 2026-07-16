// 单前置符号金额:`{+|−}usd(|v|)`(真负号 U+2212),零值无符号。
// 全站涨跌/盈亏共用(hero 日增 / 代币行与协议行 <ValueDelta> / 资产抽屉 / perp 权益条)——
// 符号与零值口径只此一处(code review:此前四处手搓,改约定会漏)。
export function signedUsd(usd: (n: number) => string, v: number): string {
  return `${v > 0 ? "+" : v < 0 ? "−" : ""}${usd(Math.abs(v))}`;
}
