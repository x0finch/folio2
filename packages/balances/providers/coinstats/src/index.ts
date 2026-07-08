import {
  type AccountType,
  type Balance,
  type BalanceProvider,
  buildTokenKey,
  defineProvider,
  type FetchContext,
  type ProviderEntry,
  ProviderError,
  parseRetryAfter,
} from "@folio/balances-basic";
import { z } from "zod";
import {
  API_KEY_HEADER,
  BALANCE_PATH,
  COINSTATS_API_BASE,
  COINSTATS_API_KEY,
  CONNECTION_IDS,
} from "./constants";

// @folio/balances-provider-coinstats —— 首个【多账户类型】provider(方案 A 工厂)。
// 一个数据源服务多个 onchain_* type(Solana / Sui / Cosmos),共享内部实现,
// 用工厂为每个 type 产出一个 BalanceProvider 对象,sync 摊平后传入 buildRegistry。
// 地址走 ctx.creds.identifier;全局 key 走工厂参数 apiKey(X-API-KEY 头)。
// 原生 fetch,零依赖。

// CoinStats wallet/balance 返回的单条 coin(仅取用到的字段;响应无图标字段 → Balance.logo 不产)。
interface CoinstatsCoin {
  symbol?: string;
  name?: string;
  amount?: number;
  price?: number | null;
  chain?: string;
  contractAddress?: string | null;
}

// 纯解析:coin[] → Balance[]。与 IO 分离,golden test。
// 该端点是钱包代币余额(现货)→ kind:"spot";value = amount * price(缺 price 记 0)、price 直传;
// 跳过无 symbol;合约行产代币标识(无数字 chainId → 兜底格式);现货行不产 meta。
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
      price: c.price ?? undefined,
      value: amount * (c.price ?? 0),
      kind: "spot",
      // 链/合约身份走 tokenKey(CAIP-19),不再进 meta;现货行无展示用 meta → 省略。
      tokenKey: buildTokenKey({ chain, contract: c.contractAddress ?? undefined }),
      name: c.name,
    });
  }
  return out;
}

// 全局 key 是实例化参数(工厂闭包;非用户账户输入)→ 用时自查。
function requireApiKey(apiKey: string | undefined): string {
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

async function fetchCoinstats(
  connectionId: string,
  ctx: CoinstatsCtx,
  apiKey: string | undefined,
): Promise<Balance[]> {
  const res = await coinstatsGet(connectionId, ctx.creds.identifier, requireApiKey(apiKey));
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
async function validateCoinstats(
  connectionId: string,
  ctx: CoinstatsCtx,
  apiKey: string | undefined,
): Promise<boolean> {
  if (!apiKey) return false;
  try {
    const res = await coinstatsGet(connectionId, ctx.creds.identifier, apiKey);
    return res.ok;
  } catch {
    return false;
  }
}

// 工厂(ADR 0009 两层构造):type 绑定 connectionId,全局 apiKey 为实例化参数,共享上面实现。
export function makeCoinstats(
  accountType: AccountType,
  connectionId: string,
  apiKey?: string,
): BalanceProvider {
  return defineProvider({
    accountType,
    // 地址非空即可(solana/sui/cosmos 格式各异,交 API 判定)。
    inputs: [
      {
        key: "identifier",
        type: "public",
        label: "Wallet Address",
        validator: z.string().trim().min(1),
      },
    ],
    fetchBalances: (ctx) => fetchCoinstats(connectionId, ctx, apiKey),
    validate: (ctx) => validateCoinstats(connectionId, ctx, apiKey),
  });
}

// 方案 A 摊平(无 key 单例:仅供测试/静态默认 registry;运行时经 entries.create 注入 key)。
export const providers: BalanceProvider[] = CONNECTION_IDS.map((c) =>
  makeCoinstats(c.accountType, c.connectionId),
);

// 自描述清单(ADR 0009):每个 type 一个 entry。id 由生态段派生(onchain_solana → solana-coinstats),
// 跨版本稳定。三个 entry 共享同一个 env 默认 key 槽(COINSTATS_API_KEY)。
export const entries: ProviderEntry[] = CONNECTION_IDS.map((c) => ({
  manifest: {
    id: `${c.accountType.split("_")[1]}-coinstats`,
    accountType: c.accountType,
    dataSource: "coinstats",
    configSchema: [
      { key: "apiKey", type: "secret", label: "CoinStats API Key", validator: z.string().min(1) },
    ],
    envDefaults: { apiKey: COINSTATS_API_KEY },
    defaultEnabled: true,
  },
  create: (settings) => makeCoinstats(c.accountType, c.connectionId, settings?.apiKey),
}));
