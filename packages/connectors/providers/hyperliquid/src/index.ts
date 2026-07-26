import {
  type BalanceProvider,
  type CredField,
  type PerpEquity,
  type PerpPosition,
  ProviderError,
  parseRetryAfter,
} from "@folio/connectors-basic";
import { tokenRef } from "@folio/oracle-ref";
import { z } from "zod";
import { CLEARINGHOUSE_TYPE, EVM_ADDRESS_RE, HYPERLIQUID_API_BASE, INFO_PATH } from "./constants";

// @folio/connectors-provider-hyperliquid —— 永续 DEX(hyperliquid connector)。只读地址即查,
// 无需签名/API key(最接近链上 provider)。POST /info { type:"clearinghouseState", user }。地址走
// account.creds.address;无全局/provider key → creds:[]。零依赖,用原生 fetch;不碰
// SECRETS_KEY/cloudflare:workers(原则 #5)。
// 注:Hyperliquid 响应里数字字段全是字符串,解析时统一 Number()。
// 【唯一的多 kind connector】:吐 perp_equity(权益行)+ perp_position(仓位行)两 kind
//   —— 取代旧的单 kind:"perp" + meta.role 判别(kind 现在自己就是判别式,role 字段随之退场)。

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

// 本 connector 会吐的 kind 子集:perp_equity | perp_position。Row 就是这两 kind 的判别联合 ——
// parseClearinghouseState 返回 Row[],写错 kind(如 kind:"spot")即【编译期】报错。
type Row = z.infer<typeof PerpEquity> | z.infer<typeof PerpPosition>;

// 永续保证金计价币(账户权益以 USDC 计)。
const MARGIN_ASSET = "USDC";

// 场馆命名者 = connectorId(与 manifest 的 `id` 同源,不许两处各写一遍)。
const PROVIDER_ID = "hyperliquid";

// symbol 大写归一由本 provider 负责(见 @folio/oracle-ref:不透明 id 原样透传)。
const venueTokenRef = (symbol: string) => tokenRef.local(PROVIDER_ID, symbol.trim().toUpperCase());

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

// —— 账户级 creds(AC):EVM 地址,public(明文落库、可导出重建)——
// 账户 creds 声明随 provider(其天然消费者)落此;将来同 connector 多 provider 时提到 entry 共享。
export const hyperliquidAccountCreds = [
  {
    key: "address",
    type: "public",
    label: "EVM Address",
    desc: "0x + 40 hex",
    validator: z.string().regex(EVM_ADDRESS_RE, "expected 0x + 40 hex"),
  },
] as const satisfies readonly CredField[];

export const hyperliquidProvider: BalanceProvider<Row, typeof hyperliquidAccountCreds> = {
  id: PROVIDER_ID,
  label: "Hyperliquid",
  // 只读地址即查,无全局/provider key/签名 → PC 空。
  creds: [],

  async fetchBalances(ctx): Promise<{ balances: Row[] }> {
    const res = await infoPost(ctx.account.creds.address);
    ensureOk(res);
    let json: ClearinghouseState;
    try {
      json = (await res.json()) as ClearinghouseState;
    } catch (cause) {
      throw new ProviderError("PARSE_ERROR", "hyperliquid returned invalid JSON", { cause });
    }
    return { balances: parseClearinghouseState(json) };
  },

  // 低消耗校验:打一次 clearinghouseState 探活(地址已由 validateCredentials 保证格式)。
  // 未交易过的地址也返回 200 + 空状态 → 视为可用。任何失败 → false。
  async validateAccount(ctx): Promise<boolean> {
    try {
      const res = await infoPost(ctx.account.creds.address);
      return res.ok;
    } catch {
      return false;
    }
  },
};
