// Tag 颜色(ADR 0034):对 **tag id** 做稳定 hash → 落到 `--chart-1..5`。与 allocation-pie 同一 token 池,
// 只引 design token;不入库、不可手改;hash 对 id 不对 name → 改名不变色。撞色可接受(不像饼图相邻要区分)。
const CHART_TOKENS = [
  "var(--chart-1)",
  "var(--chart-2)",
  "var(--chart-3)",
  "var(--chart-4)",
  "var(--chart-5)",
];

export function tagColor(tagId: string): string {
  let h = 0;
  for (let i = 0; i < tagId.length; i++) {
    h = (h * 31 + tagId.charCodeAt(i)) | 0;
  }
  return CHART_TOKENS[Math.abs(h) % CHART_TOKENS.length]!;
}
