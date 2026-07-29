import {
  type BalanceProvider,
  type CredField,
  type Defi,
  ProviderError,
  parseRetryAfter,
  type Spot,
} from "@folio/connectors-basic";
import { defineLimit } from "@folio/ratelimit";
import { z } from "zod";
import {
  CACHE_TOKEN_LIST_PATH,
  CHAIN_LIST_PATH,
  CHAINS_CACHE_TTL_MS,
  COMPLEX_PROTOCOL_LIST_PATH,
  EVM_ADDRESS_RE,
  MAX_REQUESTS_PER_SECOND,
  PROVIDER_ID,
  RABBY_API_BASE,
  TOTAL_BALANCE_PATH,
} from "./constants";
import { parseChainIds, parseProtocols, parseTokens } from "./parse";
import type { RabbyChain, RabbyProtocol, RabbyToken } from "./types";

// @folio/connectors-provider-rabby —— evm connector 的默认取数 provider(Zerion 降为可选备源)。
// 只读地址,两个请求拿回跨所有 EVM 链的钱包代币 + DeFi 仓位、自带 USD 单价。
//
// **不需要任何 API key** —— 这是换过来的主要收益(少一个 secret)。代价是请求必须签名:
// 不签名只有一个每 40 秒放一发的桶(实测),签了名才可用。签名怎么进 Worker 见 src/sign.ts。
// 零依赖,用原生 fetch;不碰 SECRETS_KEY / cloudflare:workers(原则 #5)。

type Row = z.infer<typeof Spot> | z.infer<typeof Defi>;

// —— 账户级 creds(AC)——
// **只为类型**:evm connector 实际用的那份值声明在组装处(entry 的 connectors/evm.ts,目前引
// @folio/connectors-provider-zerion 的导出)。两个 provider 包不能互相依赖(原则 #3),所以这里
// 是本地声明;键对不上的话 defineConnector 会在编译期拒掉这个 provider —— TS 就是这里的守卫,
// 不需要运行时校验。下面这个 validator 不会被执行(跑的是组装处那一份)。
const accountCreds = [
  {
    key: "address",
    type: "public",
    validator: z.string().regex(EVM_ADDRESS_RE, "expected 0x + 40 hex"),
    label: "EVM Address",
    desc: "0x + 40 hex",
  },
] as const satisfies readonly CredField[];

// provider 级 creds(PC):**空** —— rabby 不要 key。于是也没有 validateCreds 这回事。
const providerCreds = [] as const satisfies readonly CredField[];

// —— IO ——

// 签名模块**按需加载,绝不提到顶层 import**。两个理由,第一个是硬的:
//   1. sign.ts 顶层 `import … from "../vendor/rabby_sign.wasm"`,而 `.wasm` 只在 Workers 运行时 /
//      构建链里解析得动。顶层引它 → 任何在**普通 node 环境**加载 registry 的地方当场炸
//      (@folio/connectors 的 registry 测试、app 的 jsdom 单测都只是想读 manifest,不想签名)。
//   2. 顺带让 wasm 实例化不进 Worker 的启动路径(启动 CPU 预算)。
let cachedSign: typeof import("./sign").signRabbyRequest | null = null;

async function sign(
  method: string,
  path: string,
  params: Record<string, string>,
): Promise<Record<string, string>> {
  cachedSign ??= (await import("./sign")).signRabbyRequest;
  return cachedSign(method, path, params);
}

// 出站请求的速率闸。**为什么需要它**:rabby 掐的不是总量而是瞬时并发 —— 实测(签名请求、同一 IP)
// 串行 150 发零 429,但 20 并发掉 5 发、第二轮 14 并发掉 12 发,而且被压过之后恢复得慢。
// 而 @folio/sync 的 SYNC_CONCURRENCY 是 6,每个账户还要发 2~3 个请求 → 真实瞬时并发 ~12,正压在坎上。
//
// **策略是「从不撞」,不是「撞了再重试」**:sync 的退避上限只有 5s,而 rabby 恢复更慢,
// 撞上了三次重试很可能全白打。所以 `capacity: 1` —— 不许突发,请求被均匀摊成 8 次/秒,
// 代价是同一账户的第二发多等 125ms,换限速永不触发。
//
// key 取 provider id:rabby 的额度实测跟**签名**走(不跟出口 IP 走),所有账户共用同一份,
// 所以必须是一个全局的闸,不是每账户一个。
const limit = defineLimit({ key: PROVIDER_ID, capacity: 1, ratePerSec: MAX_REQUESTS_PER_SECOND });

// 发一个签名过的 GET。每发都过速率闸。
// 网络故障 → UPSTREAM_ERROR(可重试);签名算不出来 → AUTH_FAILED(**不可重试**)。
// 签名失败归到 AUTH_FAILED 而不是 UPSTREAM_ERROR,是因为它和「凭据被远端拒绝」在处理上同类:
// 重试没有意义、要人介入(通常意味着上游改了签名协议,得重新 vendoring)。若错标成可重试,
// 会退化成「三次退避全白打」还把真正的原因盖掉。
async function rabbyGet(path: string, params: Record<string, string>): Promise<Response> {
  let headers: Record<string, string>;
  try {
    headers = await sign("GET", path, params);
  } catch (cause) {
    throw new ProviderError("AUTH_FAILED", "rabby: request signing failed", { cause });
  }
  const query = new URLSearchParams(params).toString();
  await limit.acquire();
  try {
    return await fetch(`${RABBY_API_BASE}${path}${query ? `?${query}` : ""}`, {
      headers: { ...headers, accept: "application/json" },
    });
  } catch (cause) {
    throw new ProviderError("UPSTREAM_ERROR", "rabby request failed", { cause });
  }
}

// 状态码 → ProviderError。rabby 的 429 **不带 Retry-After**(实测),所以 retryAfterMs 是 undefined,
// 走 sync 的默认退避 —— 但真撞上了退避大概不够(它恢复得慢),所以指望的是闸而不是重试。
function ensureOk(res: Response): void {
  if (res.ok) return;
  if (res.status === 429) {
    throw new ProviderError("RATE_LIMITED", "rabby rate limited", {
      retryAfterMs: parseRetryAfter(res.headers.get("retry-after")),
    });
  }
  if (res.status === 401 || res.status === 403) {
    throw new ProviderError("AUTH_FAILED", `rabby auth failed (${res.status})`);
  }
  throw new ProviderError("UPSTREAM_ERROR", `rabby upstream error (${res.status})`);
}

async function getJson<T>(path: string, params: Record<string, string>): Promise<T> {
  const res = await rabbyGet(path, params);
  ensureOk(res);
  try {
    return (await res.json()) as T;
  } catch (cause) {
    throw new ProviderError("PARSE_ERROR", `rabby returned invalid JSON (${path})`, { cause });
  }
}

// —— 链清单缓存(isolate 级;chainId 不可变,24h 够)——
let chainIdsCache: { map: Record<string, number>; fetchedAt: number } | null = null;

// 仅测试用:清进程内链映射缓存(否则用例间顺序耦合)。生产代码勿调。
export function resetChainIdsCacheForTests(): void {
  chainIdsCache = null;
}

// 返回非空的 slug→chainId 映射,否则【抛错】。刷新失败但有旧缓存 → 用旧的(chainId 不可变,仍正确);
// 一份都没有 → 抛(可重试),让整轮失败重试 —— 不产 slug 兜底形(见 parse.ts 的 refOf)。
async function getChainIds(): Promise<Record<string, number>> {
  if (chainIdsCache && Date.now() - chainIdsCache.fetchedAt < CHAINS_CACHE_TTL_MS) {
    return chainIdsCache.map;
  }
  try {
    const map = parseChainIds(await getJson<RabbyChain[]>(CHAIN_LIST_PATH, {}));
    if (Object.keys(map).length === 0) {
      throw new ProviderError("UPSTREAM_ERROR", "rabby chain list empty");
    }
    chainIdsCache = { map, fetchedAt: Date.now() };
    return map;
  } catch (err) {
    if (chainIdsCache) return chainIdsCache.map;
    if (err instanceof ProviderError) throw err; // 保留 429 / AUTH_FAILED 等语义
    throw new ProviderError("UPSTREAM_ERROR", "rabby chain list fetch failed", { cause: err });
  }
}

export const rabbyProvider: BalanceProvider<Row, typeof accountCreds, typeof providerCreds> = {
  id: PROVIDER_ID,
  label: "Rabby",
  creds: providerCreds,

  async fetchBalances(ctx): Promise<{ balances: Row[] }> {
    const address = ctx.account.creds.address;
    // **刻意串行,不 Promise.all** —— 单账户瞬时并发压到 1。sync 已经在账户维度并发 6 了,
    // 每个账户再并发 2~3 发就是 ~12,正压在 rabby 的坎上(见上面 limit 那段)。
    const chainIds = await getChainIds();
    const tokens = await getJson<RabbyToken[]>(CACHE_TOKEN_LIST_PATH, { id: address });
    const protocols = await getJson<RabbyProtocol[]>(COMPLEX_PROTOCOL_LIST_PATH, { id: address });
    return {
      balances: [...parseTokens(tokens, chainIds), ...parseProtocols(protocols, chainIds)],
    };
  },

  // 低消耗校验:打最轻的 total_balance 探活(地址格式已由组装处的 validator 保证)。任何失败 → false。
  async validateAccount(ctx): Promise<boolean> {
    try {
      const res = await rabbyGet(TOTAL_BALANCE_PATH, { id: ctx.account.creds.address });
      return res.ok;
    } catch {
      return false;
    }
  },

  // 没有 validateCreds —— PC 为空,没有「provider 自身凭据」这回事。
};
