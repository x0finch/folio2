import {
  type AccountType,
  type Balance,
  type BalanceProvider,
  defineProvider,
  type FetchContext,
  ProviderError,
  parseRetryAfter,
} from "@folio/core";
import { z } from "zod";
import {
  API_KEY_HEADER,
  BALANCE_PATH,
  COINSTATS_API_BASE,
  COINSTATS_API_KEY,
  CONNECTION_IDS,
} from "./constants";

// @folio/provider-coinstats —— 首个【多账户类型】provider(方案 A 工厂)。
// 一个数据源服务多个 onchain_* type(Solana / Sui / Cosmos),共享内部实现,
// 用工厂为每个 type 产出一个 BalanceProvider 对象,sync 摊平后传入 buildRegistry。
// 地址走 ctx.creds.identifier;全局 key 走 ctx.globalKeys.COINSTATS_API_KEY(X-API-KEY 头)。
// 原生 fetch,零依赖。

// CoinStats wallet/balance 返回的单条 coin(仅取用到的字段)。
interface CoinstatsCoin {
  symbol?: string;
  amount?: number;
  price?: number | null;
  chain?: string;
  connectionId?: string;
  contractAddress?: string | null;
}

// 纯解析:coin[] → Balance[]。与 IO 分离,golden test。
// 该端点是钱包代币余额(现货)→ kind:"spot";usdValue = amount * price(缺 price 记 0);
// 跳过无 symbol;链/连接/合约写入 meta,source=链。
export function parseBalances(coins: CoinstatsCoin[], fallbackChain: string): Balance[] {
  const out: Balance[] = [];
  for (const c of coins ?? []) {
    const symbol = c.symbol?.trim();
    if (!symbol) continue;
    const amount = c.amount ?? 0;
    const chain = c.chain ?? fallbackChain;
    out.push({
      symbol,
      amount,
      usdValue: amount * (c.price ?? 0),
      source: chain,
      kind: "spot",
      meta: {
        chain,
        connectionId: c.connectionId ?? fallbackChain,
        contractAddress: c.contractAddress ?? undefined,
      },
    });
  }
  return out;
}

// 全局 key 来自服务端 env(非用户输入)→ 仍需自查。
function getApiKey(globalKeys: Record<string, string>): string {
  const apiKey = globalKeys[COINSTATS_API_KEY];
  if (!apiKey) {
    throw new ProviderError("INVALID_CREDENTIALS", `${COINSTATS_API_KEY} not configured`);
  }
  return apiKey;
}

// 各 type 共享:creds 形状 = { identifier }(地址已由 validateCredentials 保证非空)。
type CoinstatsCtx = FetchContext<{ identifier: string }>;

async function coinstatsGet(
  connectionId: string,
  address: string,
  apiKey: string,
): Promise<Response> {
  const url = `${COINSTATS_API_BASE}${BALANCE_PATH}?address=${encodeURIComponent(address)}&connectionId=${encodeURIComponent(connectionId)}`;
  try {
    return await fetch(url, { headers: { [API_KEY_HEADER]: apiKey, accept: "application/json" } });
  } catch (cause) {
    throw new ProviderError("UPSTREAM_ERROR", "coinstats request failed", { cause });
  }
}

function ensureOk(res: Response): void {
  if (res.ok) return;
  if (res.status === 401 || res.status === 403) {
    throw new ProviderError("AUTH_FAILED", `coinstats auth failed (${res.status})`);
  }
  if (res.status === 429) {
    throw new ProviderError("RATE_LIMITED", "coinstats rate limited", {
      retryAfterMs: parseRetryAfter(res.headers.get("retry-after")),
    });
  }
  throw new ProviderError("UPSTREAM_ERROR", `coinstats upstream error (${res.status})`);
}

async function fetchCoinstats(connectionId: string, ctx: CoinstatsCtx): Promise<Balance[]> {
  const apiKey = getApiKey(ctx.globalKeys);
  const res = await coinstatsGet(connectionId, ctx.creds.identifier, apiKey);
  ensureOk(res);
  let json: CoinstatsCoin[];
  try {
    json = (await res.json()) as CoinstatsCoin[];
  } catch (cause) {
    throw new ProviderError("PARSE_ERROR", "coinstats returned invalid JSON", { cause });
  }
  return parseBalances(json, connectionId);
}

// 低消耗校验:打一次 wallet/balance 探活(地址已由 validateCredentials 保证非空)。任何失败 → false。
// 三链地址格式各异(sui 0x+64hex / cosmos bech32 / solana base58),格式交给 API 判定。
async function validateCoinstats(connectionId: string, ctx: CoinstatsCtx): Promise<boolean> {
  const apiKey = ctx.globalKeys[COINSTATS_API_KEY];
  if (!apiKey) return false;
  try {
    const res = await coinstatsGet(connectionId, ctx.creds.identifier, apiKey);
    return res.ok;
  } catch {
    return false;
  }
}

// 工厂:为一个 type 绑定其 connectionId,产出一个 BalanceProvider(共享上面实现)。
export function makeCoinstats(accountType: AccountType, connectionId: string): BalanceProvider {
  return defineProvider({
    accountType,
    usesGlobalKeys: [COINSTATS_API_KEY], // 最小权限:只下发这个 key
    // 地址非空即可(solana/sui/cosmos 格式各异,交 API 判定)。
    inputs: [{ key: "identifier", type: "text", validator: z.string().trim().min(1) }],
    fetchBalances: (ctx) => fetchCoinstats(connectionId, ctx),
    validate: (ctx) => validateCoinstats(connectionId, ctx),
  });
}

// 方案 A 摊平:每个 type 一个 provider 对象,共享实现。sync 收集后 .flat() 传入 buildRegistry。
export const providers: BalanceProvider[] = CONNECTION_IDS.map((c) =>
  makeCoinstats(c.accountType, c.connectionId),
);
