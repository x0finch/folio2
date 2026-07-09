import {
  type BalanceProvider,
  type CredField,
  type FetchContext,
  ProviderError,
  parseRetryAfter,
  type Spot,
} from "@folio/connectors-basic";
import { buildTokenKey } from "@folio/tokens-basic";
import { z } from "zod";
import {
  API_KEY_HEADER,
  BALANCE_PATH,
  BLOCKCHAINS_PATH,
  COINSTATS_API_BASE,
  COINSTATS_API_KEY,
} from "./constants";

// @folio/connectors-provider-coinstats —— 首个【一个 provider 包 → 多个 connector】的用例(方案 A 工厂)。
// 一个数据源服务多条链(Solana / Sui / Cosmos),共享内部实现;工厂按 connectionId 产出一个 provider,
// 由 entry 的三份 connector manifest 各自组合。地址走 account.creds.identifier;provider key(COINSTATS_API_KEY)
// 走 ctx.creds(app 分派桥按 field.key 从 env 注入默认值),X-API-KEY 头。
// 零依赖,用原生 fetch;不碰 SECRETS_KEY/cloudflare:workers(原则 #5)。

// CoinStats wallet/balance 返回的单条 coin(仅取用到的字段;响应无图标字段 → Balance.logo 不产)。
interface CoinstatsCoin {
  symbol?: string;
  name?: string;
  amount?: number;
  price?: number | null;
  chain?: string;
  contractAddress?: string | null;
}

// 本 connector 会吐的 kind:spot(现货)。
type Row = z.infer<typeof Spot>;

// 纯解析:coin[] → Spot[]。与 IO 分离,golden test。
// 该端点是钱包代币余额(现货)→ kind:"spot";value = amount * price(缺 price 记 0)、price 直传;
// 跳过无 symbol;合约行产代币标识(无数字 chainId → 兜底格式);现货行不产 meta(新 schema 无 meta 字段)。
export function parseBalances(coins: CoinstatsCoin[], fallbackChain: string): Row[] {
  const out: Row[] = [];
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
      // 有合约 → chain:<slug>/token:<addr>;无合约(原生币 SOL/SUI…)→ chain:<slug>/native:<sym>
      // (与 evm eip155:.../native、bitcoin chain:bitcoin/native 口径一致;native key 解析时降级 symbol,见 tokens service)。
      tokenKey: buildTokenKey({
        chain,
        contract: c.contractAddress ?? undefined,
        native: c.contractAddress == null,
        symbol,
      }),
      name: c.name,
    });
  }
  return out;
}

// —— 账户级 creds(AC):钱包地址,public(明文落库、可导出重建)。三链共享此声明 ——
// 地址非空即可(solana base58 / sui 0x+64hex / cosmos bech32 格式各异,交 API 判定,与旧行为一致)。
export const coinstatsAccountCreds = [
  {
    key: "identifier",
    type: "public",
    label: "Wallet Address",
    validator: z.string().trim().min(1),
  },
] as const satisfies readonly CredField[];

// —— provider 级 creds(PC):CoinStats API Key。DEFAULT provider key —— 值由 app 分派桥从 env 注入,
// 用户自配留后续 phase。secret(仅声明形状;本包不加密、不见 SECRETS_KEY)。——
const providerCreds = [
  {
    key: COINSTATS_API_KEY,
    type: "secret",
    validator: z.string().min(1),
    label: "CoinStats API Key",
  },
] as const satisfies readonly CredField[];

// 各链共享的取数上下文:AC = { identifier },PC = provider key map。
type CoinstatsCtx = FetchContext<{ identifier: string }, Record<string, string>>;

// provider key 由 app 从 env 注入(非用户输入)→ 仍需自查。
function getApiKey(creds: Record<string, string>): string {
  const apiKey = creds[COINSTATS_API_KEY];
  if (!apiKey) {
    throw new ProviderError("INVALID_CREDENTIALS", `${COINSTATS_API_KEY} not configured`);
  }
  return apiKey;
}

// 发起 CoinStats GET;网络故障 → UPSTREAM_ERROR(可重试)。状态码由调用方用 ensureOk 处理。
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

async function fetchCoinstats(connectionId: string, ctx: CoinstatsCtx): Promise<Row[]> {
  const apiKey = getApiKey(ctx.creds);
  const res = await coinstatsGet(connectionId, ctx.account.creds.identifier, apiKey);
  ensureOk(res);
  let json: CoinstatsCoin[];
  try {
    json = (await res.json()) as CoinstatsCoin[];
  } catch (cause) {
    throw new ProviderError("PARSE_ERROR", "coinstats returned invalid JSON", { cause });
  }
  // ⚠️ fallbackChain = connectionId(behavior-preserving,含 sui 的 "sui-wallet"):
  // 无 chain 的 coin 退化按 connectionId 归链,与旧 @folio/balances 完全一致。
  return parseBalances(json, connectionId);
}

// 低消耗校验:打一次 wallet/balance 探活(地址已由 validateCredentials 保证非空)。任何失败 → false。
async function validateCoinstats(connectionId: string, ctx: CoinstatsCtx): Promise<boolean> {
  const apiKey = ctx.creds[COINSTATS_API_KEY];
  if (!apiKey) return false;
  try {
    const res = await coinstatsGet(connectionId, ctx.account.creds.identifier, apiKey);
    return res.ok;
  } catch {
    return false;
  }
}

// provider 自身 creds(COINSTATS_API_KEY)liveness:用 key 实测打 /wallet/blockchains
//(只需 key、不需地址)—— 真正验证 key 有效,而非仅存在性检查。任何失败 → false。
async function validateApiKey(apiKey: string): Promise<boolean> {
  if (!apiKey) return false;
  try {
    const res = await fetch(`${COINSTATS_API_BASE}${BLOCKCHAINS_PATH}`, {
      headers: { [API_KEY_HEADER]: apiKey, accept: "application/json" },
    });
    return res.ok;
  } catch {
    return false;
  }
}

// 工厂:为一条链绑定其 connectionId,产出一个 BalanceProvider(共享上面实现)。
// 三份 connector manifest(solana/sui/cosmos)各调一次 → 一个 provider 包服务多个 connector。
export function createCoinstatsProvider(
  connectionId: string,
): BalanceProvider<Row, typeof coinstatsAccountCreds, typeof providerCreds> {
  return {
    id: "coinstats",
    label: "CoinStats",
    creds: providerCreds,
    fetchBalances: (ctx) => fetchCoinstats(connectionId, ctx),
    validateAccount: (ctx) => validateCoinstats(connectionId, ctx),
    validateCreds: (creds) => validateApiKey(creds[COINSTATS_API_KEY]),
  };
}
