import {
  type BalanceProvider,
  type CredField,
  hmacSha256,
  ProviderError,
  parseRetryAfter,
  type Spot,
} from "@folio/connectors-basic";
import { tokenRef } from "@folio/oracle-ref";
import { z } from "zod";
import {
  ACCOUNT_PATH,
  API_KEY_HEADER,
  BINANCE_API_BASE,
  QUOTE_ASSET,
  RECV_WINDOW,
  STABLECOINS,
  TICKER_PRICE_PATH,
} from "./constants";

// @folio/connectors-provider-binance —— 首个带 secret 型 account.creds 的 connector(binance)。
// 每账户密钥(apiKey/secret)走 account.creds(加密入库,取数时由 app 分派桥 openCreds 解密后灌进
// ctx.account.creds)—— 不是全局 provider key,故 provider 级 creds(PC)为空。
// Binance 余额只给数量(free/locked,无 USD)→ 用公开 /ticker/price 按 asset→USDT 自行估值。
// HMAC 只读签名。零依赖,用原生 fetch;不碰 SECRETS_KEY/cloudflare:workers(原则 #5)。

interface BinanceBalance {
  asset?: string;
  free?: string;
  locked?: string;
}
interface BinanceAccount {
  balances?: BinanceBalance[];
}
interface TickerPrice {
  symbol?: string;
  price?: string;
}

// 原币数量展示格式化(最多 8 位小数 + 千分位)。仅 note 文案用。
const fmtAmount = (n: number): string => n.toLocaleString("en-US", { maximumFractionDigits: 8 });

// 场馆命名者 = connectorId(与 manifest 的 `id` 同源,不许两处各写一遍)。
const PROVIDER_ID = "binance";

// 纯解析:account.balances + 价格表(symbol→price)→ Spot[]。与 IO 分离,golden test。
// amount = free + locked;跳过 ≤0;usdValue:稳定币≈1,否则 amount × price(`${asset}USDT`),无对→0。
// 锁仓 note(note 重设计,balance 级单个 Note):locked>0 的币,在【它自己那笔 balance】上挂一个
// `Locked` 段(icon warning;content 一行内联文案 `${锁定数量} ${币种} · ${占该币总持有的百分比}`,
// 如 `1 ETH · 33%`,原币口径不换 USD)。无锁仓 → 无 note。
export function parseAccountBalances(
  account: BinanceAccount,
  prices: Record<string, number>,
): Spot[] {
  const out: Spot[] = [];
  for (const b of account.balances ?? []) {
    const asset = b.asset;
    if (!asset) continue;
    const locked = Number(b.locked ?? 0);
    const amount = Number(b.free ?? 0) + locked;
    if (!(amount > 0)) continue;
    const price = STABLECOINS.has(asset) ? 1 : (prices[`${asset}${QUOTE_ASSET}`] ?? undefined);
    const usdValue = price != null ? amount * price : 0;
    const row: Spot = {
      symbol: asset,
      amount,
      price,
      value: usdValue,
      kind: "spot",
      // 场馆命名:币安管这个币叫 `asset`。symbol 大写归一由本 provider 负责(见 @folio/oracle-ref)。
      tokenRef: tokenRef.opaque(PROVIDER_ID, asset.trim().toUpperCase()),
    };
    if (locked > 0) {
      const pct = amount > 0 ? Math.round((locked / amount) * 100) : 0;
      row.note = {
        title: "Locked",
        icon: "warning",
        content: `${fmtAmount(locked)} ${asset} · ${pct}%`,
      };
    }
    out.push(row);
  }
  return out;
}

async function binanceFetch(path: string, apiKey?: string): Promise<Response> {
  try {
    return await fetch(`${BINANCE_API_BASE}${path}`, {
      headers: apiKey ? { [API_KEY_HEADER]: apiKey } : {},
    });
  } catch (cause) {
    throw new ProviderError("UPSTREAM_ERROR", "binance request failed", { cause });
  }
}

function ensureOk(res: Response): void {
  if (res.ok) return;
  if (res.status === 401 || res.status === 403) {
    throw new ProviderError("AUTH_FAILED", `binance auth failed (${res.status})`);
  }
  if (res.status === 418 || res.status === 429) {
    throw new ProviderError("RATE_LIMITED", `binance rate limited (${res.status})`, {
      retryAfterMs: parseRetryAfter(res.headers.get("retry-after")),
    });
  }
  throw new ProviderError("UPSTREAM_ERROR", `binance upstream error (${res.status})`);
}

// 签名拉取 SIGNED 端点(query 串签名后追加 &signature=)。
async function signedGet(
  path: string,
  query: string,
  apiKey: string,
  secret: string,
): Promise<Response> {
  const signature = await hmacSha256(secret, query, "hex");
  return binanceFetch(`${path}?${query}&signature=${signature}`, apiKey);
}

// —— 账户级 creds(AC):apiKey/secret。apiKey = 标识符(明文走 header,非认证秘密)→ semi:
// 导出打码保留供补录识别;secret = 签名密钥 → secret:导出剥离。账户 creds 声明随 provider(其天然
// 消费者)落此;将来同 connector 多 provider 时提到 entry 共享。——
export const binanceAccountCreds = [
  { key: "apiKey", type: "semi", label: "API Key", validator: z.string().trim().min(1) },
  { key: "secret", type: "secret", label: "API Secret", validator: z.string().trim().min(1) },
] as const satisfies readonly CredField[];

export const binanceProvider: BalanceProvider<Spot, typeof binanceAccountCreds> = {
  id: PROVIDER_ID,
  label: "Binance",
  // 无全局 provider key —— 账户自己的 apiKey/secret 即凭据,走 account.creds。
  creds: [],

  async fetchBalances(ctx): Promise<{ balances: Spot[] }> {
    const { apiKey, secret } = ctx.account.creds;
    const query = `recvWindow=${RECV_WINDOW}&timestamp=${Date.now()}`;
    const acctRes = await signedGet(ACCOUNT_PATH, query, apiKey, secret);
    ensureOk(acctRes);
    let account: BinanceAccount;
    try {
      account = (await acctRes.json()) as BinanceAccount;
    } catch (cause) {
      throw new ProviderError("PARSE_ERROR", "binance returned invalid JSON", { cause });
    }
    // 公开免签:全市场价 → symbol→price 表。
    const priceRes = await binanceFetch(TICKER_PRICE_PATH);
    ensureOk(priceRes);
    let tickers: TickerPrice[];
    try {
      tickers = (await priceRes.json()) as TickerPrice[];
    } catch (cause) {
      throw new ProviderError("PARSE_ERROR", "binance returned invalid JSON", { cause });
    }
    const prices: Record<string, number> = {};
    for (const t of tickers) {
      if (t.symbol) prices[t.symbol] = Number(t.price ?? 0);
    }
    return { balances: parseAccountBalances(account, prices) };
  },

  // 校验:签名打 /api/v3/account 确认 key + 读权限(creds 已由 validateCredentials 保证非空)。
  async validateAccount(ctx): Promise<boolean> {
    const { apiKey, secret } = ctx.account.creds;
    try {
      const query = `recvWindow=${RECV_WINDOW}&timestamp=${Date.now()}`;
      const res = await signedGet(ACCOUNT_PATH, query, apiKey, secret);
      return res.ok;
    } catch {
      return false;
    }
  },
};
