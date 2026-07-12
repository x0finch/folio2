import {
  type DefiLlamaCoinId,
  refKey,
  TokenError,
  type TokenInfo,
  type TokenPrice,
  type TokenRef,
} from "@folio/oracle-basic";

// DefiLlama coin key → 规范 TokenRef(source:"defillama")。key 形如 `{chain}:{address}` 或 `coingecko:{id}`。
const dl = (key: string): TokenRef => ({ source: "defillama", identifier: key as DefiLlamaCoinId });

// 一条 coin 价数据(/prices/current 的 coins[key])。timestamp 为秒;无 24h 涨跌字段。
interface RawCoin {
  price?: number;
  symbol?: string;
  decimals?: number;
  timestamp?: number;
  confidence?: number;
}

interface RawPricesCurrent {
  coins?: Record<string, RawCoin>;
}

// 校验并取出 coins 表(共享给按 key 索引 / 单 key 取)。
function coinsOf(json: unknown): Record<string, RawCoin> {
  if (typeof json !== "object" || json === null || !("coins" in json)) {
    throw new TokenError("PARSE_ERROR", "prices/current: expected { coins: {} }");
  }
  const coins = (json as RawPricesCurrent).coins;
  if (typeof coins !== "object" || coins === null) {
    throw new TokenError("PARSE_ERROR", "prices/current: coins not an object");
  }
  return coins;
}

// /prices/current → 按 refKey 索引的价(USD)。跳过无数值 price 的项;asOf = timestamp(秒)×1000。
export function parseCurrentPrices(json: unknown): Map<string, TokenPrice> {
  const coins = coinsOf(json);
  const out = new Map<string, TokenPrice>();
  for (const [key, raw] of Object.entries(coins)) {
    if (typeof raw?.price !== "number") continue;
    const ref = dl(key);
    out.set(refKey(ref), {
      ref,
      unitPrice: raw.price,
      asOf: typeof raw.timestamp === "number" ? raw.timestamp * 1000 : 0,
    });
  }
  return out;
}

// 单 coin key(fetchByContract 用)→ {ref, info, price} | null。DefiLlama 只供 symbol(无 name/logo),
// name 退化为 symbol —— 它非 tokenMeta 源(vendor 仅声明 prices),身份/元信息权威在 baseline。
export function parseCoin(
  json: unknown,
  key: string,
): { ref: TokenRef; info: TokenInfo; price: TokenPrice } | null {
  const raw = coinsOf(json)[key];
  if (typeof raw?.price !== "number") return null;
  const ref = dl(key);
  const symbol = raw.symbol ?? "";
  return {
    ref,
    info: { ref, symbol, name: symbol },
    price: {
      ref,
      unitPrice: raw.price,
      asOf: typeof raw.timestamp === "number" ? raw.timestamp * 1000 : 0,
    },
  };
}
