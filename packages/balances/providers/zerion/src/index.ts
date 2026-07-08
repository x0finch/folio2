import {
  type Balance,
  type BalanceProvider,
  buildTokenKey,
  type DefiMeta,
  defineProvider,
  type ProviderEntry,
  ProviderError,
  parseRetryAfter,
} from "@folio/balances-basic";
import { z } from "zod";
import {
  CHAINS_CACHE_TTL_MS,
  CHAINS_PATH,
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

// 纯解析:Zerion positions → Balance[]。与 IO 分离,便于 golden test。
// 规则:跳过 displayable=false(垃圾/隐藏);无 symbol 跳过;position_type!=="wallet"
// 或带 protocol → defi,否则 spot;value 缺失记 0;protocol/positionType 进 meta。
// 代币标识:implementations 里当前链那条的 address + 数字 chainId → 规范 eip155 CAIP-19。
// chainIds 必传(由 getChainIds 保证非空):某仓位的链拿不到数字 chainId 就【抛错】——
// 绝不退化成 chain:<slug> 兜底形(那会与规范形分裂身份、污染代币索引),失败即不产、整轮重试。
// 代币元信息:name/icon.url 上 Balance(喂参考层)。
export function parsePositions(
  res: ZerionPositionsResponse,
  chainIds: Record<string, number>,
): Balance[] {
  const out: Balance[] = [];
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
    out.push({
      symbol,
      amount: a.quantity?.float ?? 0,
      price: a.price ?? undefined,
      value: a.value ?? 0,
      kind: isDefi ? "defi" : "spot",
      tokenKey: buildTokenKey({
        chainId,
        contract,
        native: impl != null && impl.address == null, // 有该链实现但无合约 → 原生币
        symbol,
      }),
      name: a.fungible_info?.name,
      logo: a.fungible_info?.icon?.url,
      // meta 只留展示字段(protocol/positionType);链/合约身份走 tokenKey,不再进 meta。
      meta: {
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
    // 链映射与 positions 并行取;链映射拿不到会抛错(Promise.all 一并 reject)→ 整轮同步失败重试,
    // 保证 parsePositions 拿到非空映射、只产规范 eip155 标识(失败即不产,不写含分叉标识的快照)。
    const [res, chainIds] = await Promise.all([
      zerionGet(`${POSITIONS_PATH(ctx.creds.identifier)}?${POSITIONS_QUERY}`, apiKey),
      getChainIds(apiKey),
    ]);
    ensureOk(res);
    let json: ZerionPositionsResponse;
    try {
      json = (await res.json()) as ZerionPositionsResponse;
    } catch (cause) {
      throw new ProviderError("PARSE_ERROR", "zerion returned invalid JSON", { cause });
    }
    return parsePositions(json, chainIds);
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

// 自描述清单(ADR 0009):id 跨版本稳定(配置覆盖行按它寻址);configSchema 声明全局设置,
// 注册/启用/配置层(@folio/provider-registry)据此驱动。
export const entries: ProviderEntry[] = [
  {
    manifest: {
      id: "evm-zerion",
      accountType: "onchain_evm",
      dataSource: "zerion",
      configSchema: [
        { key: "apiKey", type: "secret", label: "Zerion API Key", validator: z.string().min(1) },
      ],
      defaultEnabled: true,
    },
    provider: zerionProvider,
  },
];
