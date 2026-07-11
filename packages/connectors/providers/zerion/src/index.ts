import {
  type BalanceProvider,
  type CredField,
  type Defi,
  ProviderError,
  parseRetryAfter,
  type Spot,
} from "@folio/connectors-basic";
import { buildTokenKey } from "@folio/tokens-basic";
import { z } from "zod";

// @folio/connectors-provider-zerion — zerion provider(evm connector 用)。只读地址,一次取回跨所有
// EVM 链的代币 + DeFi 仓位、自带 USD 估值。地址走 account.creds.address;provider key(ZERION_API_KEY)
// 走 ctx.creds(app 分派桥按 field.key 从 env 注入默认值)。HTTP Basic:key 作 username、密码空。
// 零依赖,用原生 fetch;不碰 SECRETS_KEY/cloudflare:workers(原则 #5)。

// —— Zerion API 常量(不硬编码散落进逻辑,见原则 #8)——
const ZERION_API_BASE = "https://api.zerion.io";
// 全量仓位(代币 + DeFi,跨所有 EVM 链一次返回)。
const POSITIONS_PATH = (address: string) => `/v1/wallets/${address}/positions/`;
// 轻量聚合(仅用于 validateAccount 探活,负载远小于 positions)。
const PORTFOLIO_PATH = (address: string) => `/v1/wallets/${address}/portfolio`;
// 链清单:slug → external_id(hex 数字 chainId)的权威来源;近静态,进程内缓存。
const CHAINS_PATH = "/v1/chains/";
const CHAINS_CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24h
// provider key 在 ctx.creds 里的键名(= app 注入的 env 变量名)。
const ZERION_API_KEY = "ZERION_API_KEY";
// 滤掉垃圾币 + 以 USD 计价。
const POSITIONS_QUERY = "filter[trash]=only_non_trash&currency=usd";
// EVM 地址格式。
const EVM_ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

// —— Zerion 响应的最小形状(仅取用到的字段)——
interface ZerionQuantity {
  float?: number;
}
interface ZerionImplementation {
  chain_id?: string;
  address?: string | null; // 原生币为 null
}
interface ZerionPosition {
  attributes?: {
    protocol?: string | null;
    position_type?: string;
    quantity?: ZerionQuantity;
    value?: number | null;
    price?: number | null;
    fungible_info?: {
      symbol?: string;
      name?: string;
      icon?: { url?: string } | null;
      implementations?: ZerionImplementation[];
    };
    flags?: { displayable?: boolean };
  };
  relationships?: { chain?: { data?: { id?: string } } };
}
interface ZerionPositionsResponse {
  data?: ZerionPosition[];
}
interface ZerionChain {
  id?: string; // slug(与 positions 的 relationships.chain 同口径)
  attributes?: { external_id?: string }; // hex 数字 chainId(如 "0x1")—— positions 响应里没有,只在此端点
}
interface ZerionChainsResponse {
  data?: ZerionChain[];
}

// 本 connector 会吐的 kind 子集:spot | defi。
type Row = z.infer<typeof Spot> | z.infer<typeof Defi>;

// 链清单 → slug→数字 chainId(external_id hex → 十进制)。tokenKey 的 eip155 标准形靠它。
export function parseChainIds(res: ZerionChainsResponse): Record<string, number> {
  const out: Record<string, number> = {};
  for (const c of res.data ?? []) {
    const hex = c.attributes?.external_id;
    if (!c.id || !hex) continue;
    const n = Number.parseInt(hex, 16);
    if (Number.isFinite(n)) out[c.id] = n;
  }
  return out;
}

// 纯解析:Zerion positions → Row[]。与 IO 分离,便于 golden test。
// 规则:跳过 displayable=false(垃圾/隐藏);无 symbol 跳过;position_type!=="wallet"
// 或带 protocol → defi,否则 spot;value 缺失记 0。
// kind 契约(新 Balance):spot 无 meta;defi 带 meta:{protocol,positionType}(展示字段)。
// 链/合约身份走 tokenKey,不再进 meta。
// 代币标识:implementations 里当前链那条的 address + 数字 chainId → 规范 eip155 CAIP-19。
// chainIds 必传(由 getChainIds 保证非空):某仓位的链拿不到数字 chainId 就【抛错】——
// 绝不退化成 chain:<slug> 兜底形(那会与规范形分裂身份、污染代币索引),失败即不产、整轮重试。
// 代币元信息:name/icon.url 上 Row(喂参考层)。
export function parsePositions(
  res: ZerionPositionsResponse,
  chainIds: Record<string, number>,
): Row[] {
  const out: Row[] = [];
  for (const p of res.data ?? []) {
    const a = p.attributes;
    if (!a || a.flags?.displayable === false) continue;
    const symbol = a.fungible_info?.symbol;
    if (!symbol) continue;
    const chain = p.relationships?.chain?.data?.id;
    const chainId = chain ? chainIds[chain] : undefined;
    if (chainId === undefined) {
      // 失败即不产:无数字 chainId → 无法产规范标识 → 硬失败(可重试),不产分叉的 slug 兜底形。
      throw new ProviderError(
        "UPSTREAM_ERROR",
        `zerion: no chainId for chain '${chain ?? "?"}' (${symbol})`,
      );
    }
    const isDefi = a.position_type !== "wallet" || Boolean(a.protocol);
    // 当前链的实现:有 address = 合约币;该链有实现但 address 为 null = 原生 gas 币。
    const impl = a.fungible_info?.implementations?.find((i) => i.chain_id === chain);
    const contract = impl?.address ?? undefined;
    const base = {
      symbol,
      amount: a.quantity?.float ?? 0,
      price: a.price ?? undefined,
      value: a.value ?? 0,
      tokenKey: buildTokenKey({
        chainId,
        contract,
        native: impl != null && impl.address == null, // 有该链实现但无合约 → 原生币
        symbol,
      }),
      name: a.fungible_info?.name,
      logo: a.fungible_info?.icon?.url,
    };
    if (isDefi) {
      // defi:带 meta(protocol/positionType)。
      out.push({
        ...base,
        kind: "defi",
        meta: { protocol: a.protocol ?? undefined, positionType: a.position_type },
      });
    } else {
      // spot:新 schema 无 meta 字段。
      out.push({ ...base, kind: "spot" });
    }
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

// slug→chainId 映射的进程内缓存(isolate 级;链清单近静态,24h 够)。
let chainIdsCache: { map: Record<string, number>; fetchedAt: number } | null = null;
// 仅测试用:清进程内链映射缓存(否则用例间顺序耦合)。生产代码勿调。
export function resetChainIdsCacheForTests(): void {
  chainIdsCache = null;
}
// 返回非空的 slug→chainId 映射,否则【抛错】。刷新失败但有旧缓存 → 用旧的(chainId 不可变,仍正确);
// 无任何映射可用 → 抛 ProviderError(可重试),让整轮 fetchBalances 失败重试 —— 不产 slug 兜底形。
async function getChainIds(apiKey: string): Promise<Record<string, number>> {
  if (chainIdsCache && Date.now() - chainIdsCache.fetchedAt < CHAINS_CACHE_TTL_MS) {
    return chainIdsCache.map;
  }
  try {
    const res = await zerionGet(CHAINS_PATH, apiKey);
    ensureOk(res); // 非 2xx → 按状态码抛 ProviderError(429 可重试 / 401 认证失败 / 其它 upstream)
    const map = parseChainIds((await res.json()) as ZerionChainsResponse);
    if (Object.keys(map).length === 0) {
      throw new ProviderError("UPSTREAM_ERROR", "zerion chains response empty");
    }
    chainIdsCache = { map, fetchedAt: Date.now() };
    return map;
  } catch (err) {
    if (chainIdsCache) return chainIdsCache.map; // 刷新失败但有旧映射:用旧的仍产正确的规范标识
    if (err instanceof ProviderError) throw err; // 保留 429/401 等语义
    throw new ProviderError("UPSTREAM_ERROR", "zerion chains fetch failed", { cause: err });
  }
}

// —— 账户级 creds(AC):EVM 地址,public(明文落库、可导出重建)——
// 账户 creds 声明随 provider(其天然消费者)落此;将来同 connector 多 provider 时提到 entry 共享。
export const evmAccountCreds = [
  {
    key: "address",
    type: "public",
    validator: z.string().regex(EVM_ADDRESS_RE, "expected 0x + 40 hex"),
    label: "EVM Address",
    desc: "0x + 40 hex",
  },
] as const satisfies readonly CredField[];

// —— provider 级 creds(PC):Zerion API Key。DEFAULT provider key —— 值由 app 分派桥从 env 注入,
// 用户自配留后续 phase。secret(仅声明形状;本包不加密、不见 SECRETS_KEY)。——
const providerCreds = [
  {
    key: ZERION_API_KEY,
    type: "secret",
    validator: z.string().min(1),
    label: "Zerion API Key",
  },
] as const satisfies readonly CredField[];

// 取该地址的全量仓位(与 getChainIds 对称,抽为独立方法)。网络/状态码错误 → ProviderError;
// 非法 JSON → PARSE_ERROR。
async function getPositions(address: string, apiKey: string): Promise<ZerionPositionsResponse> {
  const res = await zerionGet(`${POSITIONS_PATH(address)}?${POSITIONS_QUERY}`, apiKey);
  ensureOk(res);
  try {
    return (await res.json()) as ZerionPositionsResponse;
  } catch (cause) {
    throw new ProviderError("PARSE_ERROR", "zerion returned invalid JSON", { cause });
  }
}

export const zerionProvider: BalanceProvider<Row, typeof evmAccountCreds, typeof providerCreds> = {
  id: "zerion",
  label: "Zerion",
  creds: providerCreds,

  async fetchBalances(ctx): Promise<{ balances: Row[] }> {
    const apiKey = ctx.creds[ZERION_API_KEY];
    // provider key 由 app 从 env 注入(非用户输入)→ 仍需自查。
    if (!apiKey) {
      throw new ProviderError("INVALID_CREDENTIALS", `${ZERION_API_KEY} not configured`);
    }
    const address = ctx.account.creds.address;
    // 链映射与 positions 并行取;链映射拿不到会抛错(Promise.all 一并 reject)→ 整轮同步失败重试,
    // 保证 parsePositions 拿到非空映射、只产规范 eip155 标识(失败即不产,不写含分叉标识的快照)。
    const [positions, chainIds] = await Promise.all([
      getPositions(address, apiKey),
      getChainIds(apiKey),
    ]);
    return { balances: parsePositions(positions, chainIds) };
  },

  // 低消耗校验:打轻量 portfolio 端点探活(地址已由 validateCredentials 保证格式)。任何失败 → false。
  async validateAccount(ctx): Promise<boolean> {
    const apiKey = ctx.creds[ZERION_API_KEY];
    if (!apiKey) return false;
    try {
      const res = await zerionGet(PORTFOLIO_PATH(ctx.account.creds.address), apiKey);
      return res.ok;
    } catch {
      return false;
    }
  },

  // provider 自身 creds liveness:用 key 实测打 /v1/chains/(只需 key、不需地址)→ res.ok,
  // 真正验证 key 有效而非仅存在性检查。key 缺失则直接 false 不发请求。
  async validateCreds(creds): Promise<boolean> {
    const apiKey = creds[ZERION_API_KEY];
    if (!apiKey) return false;
    try {
      const res = await zerionGet(CHAINS_PATH, apiKey);
      return res.ok;
    } catch {
      return false;
    }
  },
};
