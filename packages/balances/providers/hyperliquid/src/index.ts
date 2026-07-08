import {
  type Balance,
  type BalanceProvider,
  defineProvider,
  type FetchContext,
  type PerpEquityMeta,
  type PerpPositionMeta,
  type ProviderEntry,
  ProviderError,
  parseRetryAfter,
} from "@folio/balances-basic";
import { CLEARINGHOUSE_TYPE, HYPERLIQUID_API_BASE, INFO_PATH } from "./constants";

// @folio/balances-provider-hyperliquid —— 永续 DEX(perp_hyperliquid)。只读地址即查、无需签名/API key
// (最接近链上 provider)。POST /info { type:"clearinghouseState", user }。地址走
// ctx.creds.identifier;无全局 key → 不声明 usesGlobalKeys。零依赖,用原生 fetch。
// 注:Hyperliquid 响应里数字字段全是字符串,解析时统一 Number()。

// —— clearinghouseState 响应的最小形状(仅取用到字段)——
interface HlLeverage {
  value?: number;
  type?: string;
  rawUsd?: string;
}
interface HlPosition {
  coin?: string;
  szi?: string; // 带符号:正=多、负=空
  entryPx?: string;
  positionValue?: string; // 名义 USD(杠杆敞口,非账户净值贡献)
  unrealizedPnl?: string;
  leverage?: HlLeverage;
  liquidationPx?: string | null;
  marginUsed?: string;
}
interface HlMarginSummary {
  accountValue?: string; // 账户总权益(保证金 + 未实现盈亏)= 对组合净值的真实贡献
  totalMarginUsed?: string;
  totalNtlPos?: string;
  totalRawUsd?: string;
}
export interface ClearinghouseState {
  marginSummary?: HlMarginSummary;
  assetPositions?: { position?: HlPosition }[];
  withdrawable?: string;
}

// 永续保证金计价币(账户权益以 USDC 计)。
const MARGIN_ASSET = "USDC";

const num = (s: string | null | undefined): number => Number(s ?? 0);

// 纯解析:clearinghouseState → Balance[]。与 IO 分离,便于 golden test。
// 模型(见 P5.1 决策 1①):永续是杠杆敞口,不能拿 notional 当 usdValue(会按杠杆放大总额)。
//  · 权益行:唯一带值的行(usdValue = accountValue),喂组合总额。
//  · 每个仓位一行:usdValue=0(不重复计;权益已含保证金 + 盈亏),方向/盈亏/杠杆等进 meta,
//    供 P5.4 永续展示读取。
export function parseClearinghouseState(state: ClearinghouseState): Balance[] {
  const out: Balance[] = [];

  // meta 用内联字面量 + `satisfies PerpEquityMeta/PerpPositionMeta`:既按契约做生产端编译期
  // 校验,又因新鲜字面量可直接装进 Balance 的通用 meta 容器(Record<string, unknown>),无需 cast。
  const ms = state.marginSummary;
  if (ms) {
    out.push({
      symbol: MARGIN_ASSET,
      amount: num(ms.accountValue),
      value: num(ms.accountValue),
      kind: "perp",
      meta: {
        role: "equity",
        withdrawable: num(state.withdrawable),
        totalMarginUsed: num(ms.totalMarginUsed),
        totalNtlPos: num(ms.totalNtlPos),
      } satisfies PerpEquityMeta,
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
      kind: "perp",
      meta: {
        role: "position",
        side: szi >= 0 ? "long" : "short",
        entryPx: num(p.entryPx),
        positionValue: num(p.positionValue),
        unrealizedPnl: num(p.unrealizedPnl),
        leverage: p.leverage?.value,
        leverageType: p.leverage?.type,
        liquidationPx: p.liquidationPx != null ? num(p.liquidationPx) : null,
        marginUsed: num(p.marginUsed),
      } satisfies PerpPositionMeta,
    });
  }

  return out;
}

// POST /info(无 auth)。网络故障 → UPSTREAM_ERROR(可重试)。状态码由调用方 ensureOk 处理。
async function infoPost(address: string): Promise<Response> {
  try {
    return await fetch(`${HYPERLIQUID_API_BASE}${INFO_PATH}`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({ type: CLEARINGHOUSE_TYPE, user: address }),
    });
  } catch (cause) {
    throw new ProviderError("UPSTREAM_ERROR", "hyperliquid request failed", { cause });
  }
}

function ensureOk(res: Response): void {
  if (res.ok) return;
  if (res.status === 429) {
    throw new ProviderError("RATE_LIMITED", "hyperliquid rate limited", {
      retryAfterMs: parseRetryAfter(res.headers.get("retry-after")),
    });
  }
  throw new ProviderError("UPSTREAM_ERROR", `hyperliquid upstream error (${res.status})`);
}

export const hyperliquidProvider = defineProvider({
  accountType: "perp_hyperliquid",

  async fetchBalances(ctx: FetchContext<{ identifier: string }>): Promise<Balance[]> {
    const res = await infoPost(ctx.creds.identifier);
    ensureOk(res);
    let json: ClearinghouseState;
    try {
      json = (await res.json()) as ClearinghouseState;
    } catch (cause) {
      throw new ProviderError("PARSE_ERROR", "hyperliquid returned invalid JSON", { cause });
    }
    return parseClearinghouseState(json);
  },

  // 账户 liveness:打一次 clearinghouseState 探活(地址格式已由层1 validator 保证)。
  // 未交易过的地址也返回 200 + 空状态 → 视为可用。任何失败 → false。
  async validateAccount(ctx: FetchContext<{ identifier: string }>): Promise<boolean> {
    try {
      const res = await infoPost(ctx.creds.identifier);
      return res.ok;
    } catch {
      return false;
    }
  },
});

// 与方案 A 摊平约定一致:sync 收集各包的 providers 数组后 .flat() 传入 buildRegistry。
export const providers: BalanceProvider[] = [hyperliquidProvider];

// 自描述清单(ADR 0009)。公开 info API,无全局设置,开箱即用。
export const entries: ProviderEntry[] = [
  {
    manifest: {
      id: "hyperliquid-api",
      accountType: "perp_hyperliquid",
      dataSource: "hyperliquid",
      configSchema: [],
      defaultEnabled: true,
    },
    create: () => hyperliquidProvider,
  },
];
