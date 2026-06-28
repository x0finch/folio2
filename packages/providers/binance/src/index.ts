import {
  type Balance,
  type BalanceProvider,
  defineProvider,
  hmacSha256,
  ProviderError,
  parseRetryAfter,
} from "@folio/core";
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

// @folio/provider-binance —— 第一个 CEX(exchange_binance),立 HMAC 只读签名模板。
// 每账户密钥(apiKey/secret)走 ctx.creds(加密入库),不是全局 key → 不声明 usesGlobalKeys。
// Binance 余额只给数量(free/locked,无 USD)→ 用公开 /ticker/price 按 asset→USDT 自行估值。
// 原生 fetch,零依赖。

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

// 纯解析:account.balances + 价格表(symbol→price)→ Balance[]。与 IO 分离,golden test。
// amount = free + locked;跳过 ≤0;usdValue:稳定币≈1,否则 amount × price(`${asset}USDT`),无对→0。
export function parseAccountBalances(
  account: BinanceAccount,
  prices: Record<string, number>,
): Balance[] {
  const out: Balance[] = [];
  for (const b of account.balances ?? []) {
    const asset = b.asset;
    if (!asset) continue;
    const amount = Number(b.free ?? 0) + Number(b.locked ?? 0);
    if (!(amount > 0)) continue;
    const usdValue = STABLECOINS.has(asset)
      ? amount
      : amount * (prices[`${asset}${QUOTE_ASSET}`] ?? 0);
    out.push({
      symbol: asset,
      amount,
      usdValue,
      source: "binance",
      kind: "spot",
      meta: { wallet: "spot" },
    });
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

export const binanceProvider = defineProvider({
  accountType: "exchange_binance",
  inputs: [
    { key: "apiKey", type: "secret", label: "API Key", validator: z.string().trim().min(1) },
    { key: "secret", type: "secret", label: "API Secret", validator: z.string().trim().min(1) },
  ],

  async fetchBalances(ctx): Promise<Balance[]> {
    const { apiKey, secret } = ctx.creds;
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
    return parseAccountBalances(account, prices);
  },

  // 校验:签名打 /api/v3/account 确认 key + 读权限(creds 已由 validateCredentials 保证非空)。
  async validate(ctx): Promise<boolean> {
    const { apiKey, secret } = ctx.creds;
    try {
      const query = `recvWindow=${RECV_WINDOW}&timestamp=${Date.now()}`;
      const res = await signedGet(ACCOUNT_PATH, query, apiKey, secret);
      return res.ok;
    } catch {
      return false;
    }
  },
});

export const providers: BalanceProvider[] = [binanceProvider];
