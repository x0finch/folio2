// @folio/fx —— 展示币种 + 汇率(FX)。存储恒 USD,换算只在展示层;见 docs/adr/0006。
// 契约镜像 @folio/platforms:source(取数)+ store(D1 缓存)+ service(resolve/warm)。

// 展示币种描述符。code:fiat=ISO 4217 大写(USD/EUR),crypto=BTC/ETH(非 ISO,自用)。
// exchange_rates 的 key 为小写 → 查表用 code.toLowerCase()。symbol 仅 crypto 需要(fiat 由 Intl 出)。
export interface Currency {
  code: string;
  kind: "fiat" | "crypto";
  symbol?: string;
}

export const DEFAULT_CURRENCY = "USD";

// 支持币种(picker 用;cookie 值按此校验)。~10 主流法币 + BTC/ETH。
export const SUPPORTED_CURRENCIES: readonly Currency[] = [
  { code: "USD", kind: "fiat" },
  { code: "EUR", kind: "fiat" },
  { code: "GBP", kind: "fiat" },
  { code: "JPY", kind: "fiat" },
  { code: "CNY", kind: "fiat" },
  { code: "KRW", kind: "fiat" },
  { code: "HKD", kind: "fiat" },
  { code: "CAD", kind: "fiat" },
  { code: "AUD", kind: "fiat" },
  { code: "CHF", kind: "fiat" },
  { code: "BTC", kind: "crypto", symbol: "₿" },
  { code: "ETH", kind: "crypto", symbol: "Ξ" },
];

// 缓存行:usdPerUnit = 1 单位该币种的美元价;expiresAt 只闸 warm(读软过期)。
export interface FxRow {
  currency: string;
  usdPerUnit: number;
  expiresAt: number;
}

// 取数:拉 exchange_rates 反算 SUPPORTED 各币种的 usdPerUnit(code → usdPerUnit)。
export interface FxSource {
  fetchRates(): Promise<Map<string, number>>;
}

export interface FxStore {
  getRates(currencies: readonly string[]): Promise<Map<string, FxRow>>;
  putRates(rows: readonly FxRow[]): Promise<void>;
}

// 对外服务:resolve 读(软过期,返最近值),warm 写(sync 后)。
export interface FxRates {
  resolve(currency: string): Promise<number | undefined>;
  warm(currencies?: readonly string[]): Promise<void>;
}

export type FxErrorCode = "RATE_LIMITED" | "UPSTREAM_ERROR" | "PARSE_ERROR";
export class FxError extends Error {
  readonly code: FxErrorCode;
  constructor(code: FxErrorCode, message: string, opts?: { cause?: unknown }) {
    super(message, opts?.cause !== undefined ? { cause: opts.cause } : undefined);
    this.name = "FxError";
    this.code = code;
  }
}
