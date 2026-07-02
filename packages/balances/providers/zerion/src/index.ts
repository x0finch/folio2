import {
  type Balance,
  type BalanceProvider,
  type DefiMeta,
  defineProvider,
  ProviderError,
  parseRetryAfter,
} from "@folio/balances-basic";
import { z } from "zod";
import {
  EVM_ADDRESS_RE,
  PORTFOLIO_PATH,
  POSITIONS_PATH,
  POSITIONS_QUERY,
  ZERION_API_BASE,
  ZERION_API_KEY,
} from "./constants";

// @folio/balances-provider-zerion —— EVM 链上(onchain_evm)。只读地址,一次取回跨所有 EVM 链的
// 代币 + DeFi 仓位、自带 USD 估值。地址走 ctx.creds.identifier;全局 key 走
// ctx.globalKeys.ZERION_API_KEY(HTTP Basic:key 作 username、密码空)。零依赖,用原生 fetch。

// —— Zerion 响应的最小形状(仅取用到的字段)——
interface ZerionQuantity {
  float?: number;
}
interface ZerionPosition {
  attributes?: {
    protocol?: string | null;
    position_type?: string;
    quantity?: ZerionQuantity;
    value?: number | null;
    fungible_info?: { symbol?: string; name?: string };
    flags?: { displayable?: boolean };
  };
  relationships?: { chain?: { data?: { id?: string } } };
}
interface ZerionPositionsResponse {
  data?: ZerionPosition[];
}

// 纯解析:Zerion positions → Balance[]。与 IO 分离,便于 golden test。
// 规则:跳过 displayable=false(垃圾/隐藏);无 symbol 跳过;position_type!=="wallet"
// 或带 protocol → defi,否则 spot;value 缺失记 0;链/协议写入 meta。
export function parsePositions(res: ZerionPositionsResponse): Balance[] {
  const out: Balance[] = [];
  for (const p of res.data ?? []) {
    const a = p.attributes;
    if (!a || a.flags?.displayable === false) continue;
    const symbol = a.fungible_info?.symbol;
    if (!symbol) continue;
    const chain = p.relationships?.chain?.data?.id ?? "unknown";
    const isDefi = a.position_type !== "wallet" || Boolean(a.protocol);
    out.push({
      symbol,
      amount: a.quantity?.float ?? 0,
      usdValue: a.value ?? 0,
      source: chain,
      kind: isDefi ? "defi" : "spot",
      // meta 形状对齐共享契约 DefiMeta(消费端总览 DeFi 分区据此窄化);satisfies 在生产端
      // 做编译期校验,key 改名会被立刻发现(契约优先,见仓位模型加固)。
      meta: {
        chain,
        protocol: a.protocol ?? undefined,
        positionType: a.position_type,
      } satisfies DefiMeta,
    });
  }
  return out;
}

function basicAuth(apiKey: string): string {
  return `Basic ${btoa(`${apiKey}:`)}`;
}

// 发起 Zerion GET;网络故障 → UPSTREAM_ERROR(可重试)。状态码由调用方用 ensureOk 处理。
async function zerionGet(path: string, apiKey: string): Promise<Response> {
  try {
    return await fetch(`${ZERION_API_BASE}${path}`, {
      headers: { Authorization: basicAuth(apiKey), accept: "application/json" },
    });
  } catch (cause) {
    throw new ProviderError("UPSTREAM_ERROR", "zerion request failed", { cause });
  }
}

function ensureOk(res: Response): void {
  if (res.ok) return;
  if (res.status === 401 || res.status === 403) {
    throw new ProviderError("AUTH_FAILED", `zerion auth failed (${res.status})`);
  }
  if (res.status === 429) {
    throw new ProviderError("RATE_LIMITED", "zerion rate limited", {
      retryAfterMs: parseRetryAfter(res.headers.get("retry-after")),
    });
  }
  throw new ProviderError("UPSTREAM_ERROR", `zerion upstream error (${res.status})`);
}

// 全局 key 来自服务端 env(非用户输入,不在 inputs/validateCredentials 范围)→ 仍需自查。
function getApiKey(globalKeys: Record<string, string>): string {
  const apiKey = globalKeys[ZERION_API_KEY];
  if (!apiKey) {
    throw new ProviderError("INVALID_CREDENTIALS", `${ZERION_API_KEY} not configured`);
  }
  return apiKey;
}

export const zerionProvider = defineProvider({
  accountType: "onchain_evm",
  usesGlobalKeys: [ZERION_API_KEY], // 最小权限:只下发这个 key 给本 provider
  // identifier 的 EVM 格式由本 validator 体现;创建/同步前经 validateCredentials 保证 → 方法里可直接用。
  inputs: [
    {
      key: "identifier",
      type: "public",
      label: "EVM Address",
      desc: "0x + 40 hex",
      validator: z.string().regex(EVM_ADDRESS_RE, "expected 0x + 40 hex"),
    },
  ],

  async fetchBalances(ctx): Promise<Balance[]> {
    const apiKey = getApiKey(ctx.globalKeys);
    const res = await zerionGet(
      `${POSITIONS_PATH(ctx.creds.identifier)}?${POSITIONS_QUERY}`,
      apiKey,
    );
    ensureOk(res);
    let json: ZerionPositionsResponse;
    try {
      json = (await res.json()) as ZerionPositionsResponse;
    } catch (cause) {
      throw new ProviderError("PARSE_ERROR", "zerion returned invalid JSON", { cause });
    }
    return parsePositions(json);
  },

  // 低消耗校验:打轻量 portfolio 端点探活(地址已由 validateCredentials 保证格式)。任何失败 → false。
  async validate(ctx): Promise<boolean> {
    const apiKey = ctx.globalKeys[ZERION_API_KEY];
    if (!apiKey) return false;
    try {
      const res = await zerionGet(PORTFOLIO_PATH(ctx.creds.identifier), apiKey);
      return res.ok;
    } catch {
      return false;
    }
  },
});

// 与方案 A 摊平约定一致:sync 收集各包的 providers 数组后 .flat() 传入 buildRegistry。
export const providers: BalanceProvider[] = [zerionProvider];
