// 增量小字的**三态**与配色口径。`<ValueDelta>`(行内小字)与账户抽屉头(大字)共用 ——
// 两处字号、布局都不同,但「什么时候显示 `—`、0 涂什么颜色」必须是同一套,否则同一笔账在
// 两个地方长得不一样。

// 「没有这个数」的占位。em dash 而不是空白 —— 空白会被读成「还没加载出来」,而这里是
// 「问过了,答不上来」。与 hero 各个 Stat 格子的空态同形。
export const NO_VALUE = "—";

// 三态(ADR 0040):
//   · `undefined` —— 这个位置本来就不该有增量(归档行:数字冻在封存那一刻)。调用方整行省略,不进这里。
//   · `null` —— 该有,但算不出(缺 24 小时前的基准 / 最近的基准太旧)。
//   · `0` —— 算出来确实没涨没跌,是一条真实结论。
// null 与 0 都**不带方向**,走中性色 —— 给 0 涂上涨/下跌的颜色是在暗示一个不存在的方向,
// 而给「不知道」涂颜色更糟。
export function deltaTone(delta: number | null): string {
  if (delta == null || delta === 0) return "text-muted-foreground";
  return delta > 0 ? "text-pos" : "text-neg";
}
