import type { PerpPositionView } from "../../../../../lib/core/account-view";

// 永续仓位的风险/盈亏推导 —— 只有本页在用(仓位列表 + LiqRing),故与它们同目录。

// —— v2 展示推导(H5 #120)——全部由既有 meta 字段客户端现推,不动 provider/schema;
// 除零/缺失一律返回 null,UI 按状态矩阵降级(环不渲染 / 只显价值)。

// 标记价 = 当前名义敞口 / 仓位绝对量。假设 positionValue 为**当前**名义值(Hyperliquid 语义,
// 见计划脆弱假设 1);若某 provider 落开仓名义值,此处会失真 —— 修正点集中在这一个函数。
export function markPx(p: PerpPositionView): number | null {
  const size = Math.abs(p.size);
  if (size === 0) return null;
  return p.positionValue / size;
}

// uPnL%(百分数):相对开仓名义值(|size| × entryPx),与杠杆无关 —— 和交易所仓位列表口径一致。
export function pnlPct(p: PerpPositionView): number | null {
  const notional = Math.abs(p.size) * p.entryPx;
  if (notional === 0) return null;
  return (p.unrealizedPnl / notional) * 100;
}

// LiqRing 三态阈值:安全余量 = 距强平价占**现价**的百分比 d = |标记−强平| / 标记(方向感知)。
// 换掉旧的「开仓→强平走了多少」度量 —— 那个把「安全」锚在开仓价、等价于「是否盈利」(稍亏即 warn),
// 且不符交易惯例。新度量与盈亏解耦、天然含杠杆(高杠杆→强平更近→d 更小→更危险),贴近交易所/看板显示。
const LIQ_WARN_BELOW = 0.15; // d < 15% → 警告
const LIQ_DANGER_BELOW = 0.05; // d < 5% → 危险
const LIQ_RING_FULL = 0.25; // d ≥ 25% → 环满(安全上限;仅决定视觉填充,不影响状态判定)

export type LiqRiskState = "safe" | "warn" | "danger";

export interface LiqRisk {
  distance: number; // 距强平占现价比例(展示为「安全余量 %」;穿仓 clamp 0)
  fill: number; // 环填充 0..1(distance 相对 LIQ_RING_FULL 封顶)
  state: LiqRiskState;
  mark: number; // 标记价(此处一并携带,消费端不再各自重推)
  liquidationPx: number; // 非空版强平价(risk 非 null 即有)
}

// 安全余量 = 距强平占**现价**的比例,方向感知:安全侧为正、标记越到强平另一侧(穿仓/脏快照)为负
// → clamp 0 = danger(无符号距离会把穿仓误读成安全)。安全方向由 sign(开仓−强平) 定(多头开仓>强平、
// 空头开仓<强平),故多空同构。强平缺失 / 开仓=强平 / 标记不可推或 ≤0 → null(行内降级为文本)。
export function liqRisk(p: PerpPositionView): LiqRisk | null {
  const mark = markPx(p);
  if (mark == null || mark <= 0 || p.liquidationPx == null) return null;
  const span = p.entryPx - p.liquidationPx;
  if (span === 0) return null;
  const distance = Math.max(((mark - p.liquidationPx) / mark) * Math.sign(span), 0);
  const state: LiqRiskState =
    distance < LIQ_DANGER_BELOW ? "danger" : distance < LIQ_WARN_BELOW ? "warn" : "safe";
  const fill = Math.min(distance / LIQ_RING_FULL, 1);
  return { distance, fill, state, mark, liquidationPx: p.liquidationPx };
}
