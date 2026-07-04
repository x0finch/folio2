import type {
  ProviderTokenSeed,
  TokenCandidate,
  TokenInfo,
  TokenPrice,
  TokenRecord,
  TokenRef,
} from "./types";

// 全局参考数据缓存(代币表 + 索引表)。**无 `userId`** —— 价/解析/元信息都是全局事实(原则 #6 受控例外)。
// 三条查找路径:代币表主键 / (source, identifier) 唯一索引(cgk id)/ tokenKey(索引表)。
// key 归一(symbol 大写、tokenKey 构造)由调用方(entry 的 normalize)完成,store 只按 key 存/查。
export interface TokenStore {
  // —— warm(top-N markets):upsert cgk 代币行 + symbol 索引(消歧候选)——
  // warmTtlMs 管 symbol 索引与价(短、要新鲜);infoTtlMs 管 name/logo(长、近静态)。
  putWarm(
    rows: { info: TokenInfo; price: TokenPrice }[],
    warmTtlMs: number,
    infoTtlMs: number,
  ): Promise<void>;
  warmAsOf(): Promise<number | null>;
  // 默认选币列表:当前 warm 集(symbol 索引未过期)按 rank 升序取前 limit。
  listTopTokens(limit: number): Promise<TokenInfo[]>;
  // 符号消歧候选:symbol 索引 join 代币表取 rank。
  getCandidates(symbol: string): Promise<TokenCandidate[]>;

  // —— tokenKey 索引(kind="tokenKey",key=eip155:<id>/erc20:<addr> 等)——
  // 读:key → 整行(cgk 或孤儿)+ cgkCheckedUntil(未收录的复查时刻;替代旧否定缓存三态)。
  getByTokenKey(
    keys: string[],
  ): Promise<Map<string, TokenRecord & { cgkCheckedUntil: number | null }>>;
  // 同步采集:miss → seed 孤儿行(source="provider",identifier=key)+ 索引行;
  // hit → 刷新 providerLogo(cgk 行填备用槽)/孤儿的 symbol/name,并顺延索引 expiry。
  ensureTokenKey(key: string, seed: ProviderTokenSeed, indexTtlMs: number): Promise<void>;
  // 问过 CGK"未收录"→ 记复查时刻(不删孤儿,期间照常展示 provider 数据)。
  markCgkChecked(key: string, until: number): Promise<void>;
  // 升级合并(CGK 收录/懒解析命中):find-or-create cgk 行 → 孤儿的 providerLogo 拷入备用槽(若空)
  // → 索引指针改指 cgk 行 → 删孤儿行;单次原子批。
  linkTokenKeyToCgk(
    key: string,
    info: TokenInfo,
    price: TokenPrice | undefined,
    ttls: { indexTtlMs: number; infoTtlMs: number; priceTtlMs: number },
  ): Promise<void>;

  // —— cgk ref 读写(富化/取价)——
  // 读:refKey → 整行;info 按 TTL 过滤(过期=未命中),价不过滤、带 stale(SWR)。
  getByRefs(refs: TokenRef[]): Promise<Map<string, TokenRecord>>;
  // 写价(priceOf 回源 / refreshStalePrices 批量):只更新已存在的行。
  putPrices(prices: TokenPrice[], ttlMs: number): Promise<void>;
}
