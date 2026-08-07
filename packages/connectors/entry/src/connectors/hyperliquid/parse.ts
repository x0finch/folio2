import type { PerpEquity, PerpPosition } from "@folio/connectors-basic";
import type { ClearinghouseState } from "@folio/hyperliquid-client";
import { tokenRef } from "@folio/oracle-ref";
import type { z } from "zod";

// 【hyperliquid 的适配层:上游形状 → folio 的 `Balance`】——**纯函数,一个都不出网**(ADR 0036)。
// 逐字搬自 `packages/connectors/provider-hyperliquid`,fixtures 一字节没动。
//
// 【唯一的多 kind connector】:吐 perp_equity(权益行)+ perp_position(仓位行)两 kind。
// 注:Hyperliquid 响应里数字字段全是字符串,解析时统一 Number()。

// 上游形状(`ClearinghouseState` 等)由 `@folio/hyperliquid-client` 定义并导出 ——
// 那是「上游怎么说话」,归请求层;这个文件只管「怎么翻译」。
// 本 connector 会吐的 kind 子集:perp_equity | perp_position。Row 就是这两 kind 的判别联合 ——
// parseClearinghouseState 返回 Row[],写错 kind(如 kind:"spot")即【编译期】报错。
export type Row = z.infer<typeof PerpEquity> | z.infer<typeof PerpPosition>;

// 永续保证金计价币(账户权益以 USDC 计)。
const MARGIN_ASSET = "USDC";

// 场馆命名者 = connectorId(与 manifest 的 `id` 同源,不许两处各写一遍)。
export const PROVIDER_ID = "hyperliquid";

// symbol 大写归一由本 provider 负责(见 @folio/oracle-ref:`issued` 的标识原样透传 —— 归一是生产者的事)。
const venueTokenRef = (symbol: string) => tokenRef.issued(PROVIDER_ID, symbol.trim().toUpperCase());

const num = (s: string | null | undefined): number => Number(s ?? 0);

// 纯解析:clearinghouseState → Row[]。与 IO 分离,便于 golden test。
// 模型(见 P5.1 决策 1①):永续是杠杆敞口,不能拿 notional 当 usdValue(会按杠杆放大总额)。
//  · 权益行(kind:"perp_equity"):唯一带值的行(value = accountValue),喂组合总额。
//  · 每个仓位一行(kind:"perp_position"):value=0(不重复计;权益已含保证金 + 盈亏),
//    方向/盈亏/杠杆等进 meta,供永续展示读取。
// kind 即判别式 → 无 role 字段;meta 形状按 PerpEquityMeta/PerpPositionMeta 精确(写错编译即挂)。
export function parseClearinghouseState(state: ClearinghouseState): Row[] {
  const out: Row[] = [];

  const ms = state.marginSummary;
  if (ms) {
    out.push({
      symbol: MARGIN_ASSET,
      amount: num(ms.accountValue),
      value: num(ms.accountValue),
      kind: "perp_equity",
      tokenRef: venueTokenRef(MARGIN_ASSET),
      meta: {
        withdrawable: num(state.withdrawable),
        totalMarginUsed: num(ms.totalMarginUsed),
        totalNtlPos: num(ms.totalNtlPos),
      },
    });
  }

  for (const ap of state.assetPositions ?? []) {
    const p = ap.position;
    if (!p?.coin) continue;
    const szi = num(p.szi);
    out.push({
      symbol: p.coin,
      amount: szi,
      value: 0, // 见上:仓位不计入总额,价值由权益行承载
      kind: "perp_position",
      // 标的的场馆命名(不是「持有该币」,只是身份)—— 值仍由权益行承载,此处不参与计价。
      tokenRef: venueTokenRef(p.coin),
      meta: {
        coin: p.coin, // 展示用币名,住 meta(不再靠快照 symbol 列,#243)
        side: szi >= 0 ? "long" : "short",
        entryPx: num(p.entryPx),
        positionValue: num(p.positionValue),
        unrealizedPnl: num(p.unrealizedPnl),
        leverage: p.leverage?.value,
        leverageType: p.leverage?.type,
        liquidationPx: p.liquidationPx != null ? num(p.liquidationPx) : null,
        marginUsed: num(p.marginUsed),
      },
    });
  }

  return out;
}

// 出网走共享的 http 包装(@folio/shared)。**没有限频器** —— 见 constants.ts 末尾那笔账:
// 1200 权重/分钟 ÷ 每次权重 2 ≈ 600 次/分钟,而我们峰值 6 发,队永远是空的。
