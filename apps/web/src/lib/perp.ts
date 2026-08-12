import {
  PerpEquityMeta,
  type PerpEquityMeta as PerpEquityMetaT,
  PerpPositionMeta,
  type PerpPositionMeta as PerpPositionMetaT,
} from "@folio/connectors-basic";
import { viewKind } from "./balance-kind";

// 纯逻辑(无 server-only import → 可单测,route 保持纯展示)。
// 把一个永续账户的余额行拆成展示用视图:equity(账户净值/可提/保证金)+ positions[]。
// kind 走 viewKind 归一:并存期同时吃新 perp_equity/perp_position(kind 即判别)与遗留 perp(靠 meta.role)。
// metaJson(落库 JSON)在此 safeParse 到各自 meta(JSON 边界仅此一处;遗留的多余 role 键被 zod strip)。
// 坏/缺 metaJson 的行被忽略,不抛(单账户脏数据不拖垮总览)。

interface PerpEquityView extends PerpEquityMetaT {
  accountValue: number; // = equity 行的 usdValue
}
export interface PerpPositionView extends PerpPositionMetaT {
  // coin 由 PerpPositionMetaT 提供(#243:住 meta)。
  size: number; // 带符号:正=多、负=空(side 同时给出)
}
export interface PerpView {
  equity: PerpEquityView | null;
  positions: PerpPositionView[];
}

interface PerpBalance {
  amount: number;
  usdValue: number;
  kind: string;
  metaJson: string | null;
}

function parseJson(metaJson: string | null): unknown {
  if (!metaJson) return null;
  try {
    return JSON.parse(metaJson);
  } catch {
    return null;
  }
}

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

// 单个永续仓位行的 typed meta(账户行叠标用,#133):要的是币名 + **名义敞口**。
//
// **名义值只在 meta 里,行的 `usdValue` 恒为 0** —— 永续仓位不贡献净值(净值由权益行承载,
// ADR 0010 / #129),所以拿 `usdValue` 去排序或过滤会让每个仓位都变成 $0、被尘埃阈值全部滤掉。
// (第一版就是这么写的,单测因为 fixture 自己编了个 usdValue 而全绿。)
//
// **不复用 `toPerpView`**:那个是「一个账户的全部永续行 → 分区视图」,而叠标是一行一行看过去的
// (它同时还要看现货与 defi 行),为它先把行按账户攒起来只是为了再拆开。
export function perpPositionMetaOf(metaJson: string | null): PerpPositionMetaT | undefined {
  const r = PerpPositionMeta.safeParse(parseJson(metaJson));
  return r.success ? r.data : undefined;
}

export function toPerpView(balances: PerpBalance[]): PerpView {
  let equity: PerpEquityView | null = null;
  const positions: PerpPositionView[] = [];

  for (const b of balances) {
    const vk = viewKind(b);
    const raw = parseJson(b.metaJson);
    if (vk === "perp_equity") {
      const r = PerpEquityMeta.safeParse(raw);
      // 多个权益行(如 Binance 的 U 本位 + 币本位两个合约钱包)→ **累加合并**成一个账户权益视图,
      // 而非互相覆盖只留最后一个。净值本就各自计入 buildCanonicalHoldings;这里只修「权益条只显一个
      // 钱包」的展示缺陷。单权益的 provider(hyperliquid)行为不变。
      if (r.success) {
        const v = { ...r.data, accountValue: b.usdValue };
        equity = equity
          ? {
              accountValue: equity.accountValue + v.accountValue,
              withdrawable: equity.withdrawable + v.withdrawable,
              totalMarginUsed: equity.totalMarginUsed + v.totalMarginUsed,
              totalNtlPos: equity.totalNtlPos + v.totalNtlPos,
            }
          : v;
      }
    } else if (vk === "perp_position") {
      const r = PerpPositionMeta.safeParse(raw);
      // coin 从 meta 取(#243:不再依赖快照 symbol 列)。PerpPositionView 的 coin 即 meta.coin。
      if (r.success) positions.push({ ...r.data, size: b.amount });
    }
  }

  return { equity, positions };
}
