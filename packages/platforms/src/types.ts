// 平台 = 持仓所在的链或场馆(chain ∪ venue),见 CONTEXT.md「Platform」。
// platformKey 文法:eip155:<chainId> / chain:<slug> / exchange:<slug> / perp:<slug>。

export interface PlatformMeta {
  key: string;
  name: string;
  logo?: string;
}

// 数据源(CoinGecko):链取整表,场馆(#03)按 key 单查。
export interface PlatformSource {
  fetchChains(): Promise<PlatformMeta[]>;
  // #03: fetchVenue(key: string): Promise<PlatformMeta | null>;
}

// 缓存行:name === null 表示否定缓存(问过、确认不存在)。
export interface PlatformRow {
  key: string;
  name: string | null;
  logo: string | null;
  expiresAt: number;
}

export interface PlatformStore {
  getPlatforms(keys: readonly string[]): Promise<Map<string, PlatformRow>>;
  putPlatforms(rows: readonly PlatformRow[]): Promise<void>;
}

// 对外服务:resolve 只读缓存(展示用),warm 写缓存(sync 后)。
export interface Platforms {
  resolve(keys: readonly string[]): Promise<Map<string, PlatformMeta>>;
  warm(keys: readonly string[]): Promise<void>;
}

export type PlatformErrorCode = "RATE_LIMITED" | "UPSTREAM_ERROR" | "PARSE_ERROR";
export class PlatformError extends Error {
  readonly code: PlatformErrorCode;
  constructor(code: PlatformErrorCode, message: string, opts?: { cause?: unknown }) {
    super(message, opts?.cause !== undefined ? { cause: opts.cause } : undefined);
    this.name = "PlatformError";
    this.code = code;
  }
}
