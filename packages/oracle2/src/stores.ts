import type {
  CgkRefRow,
  PricePoint,
  Token,
  TokenInfoPatch,
  TokenPriceWrite,
  TokenRef,
  TokenSeed,
} from "./types";

// 三个 store 契约。实现在别处(D1 在 @folio/db,测试用内存假实现),oracle 只认接口。
//
// **每个 store 都已经绑好了 userId,但本层不知道有 userId 这回事** —— `oracleFor(userId)` 在
// 工厂那一层就把它吃掉了(见 oracle.ts)。所以下面所有方法的签名里都没有 user 参数:
// 拿错用户在编译期就发生不了,而服务代码也不必到处传一个它根本不该关心的东西。
// 唯一的例外是 `CgkRefStore` —— 它是**全局**的公开知识(哪个合约是哪个币),本来就与用户无关。

// —— per-user 代币表 ——
export interface TokenStore {
  // mint 第一步:一批 tokenRef 里,哪些已经有 Token 了。绝大多数同步都停在这里。
  findByRefs(refs: readonly TokenRef[]): Promise<Map<TokenRef, string>>;

  // 建一个新 Token 并挂上这些 ref。**幂等**:账户是并发跑的,同一条 ref 会被同时 mint →
  // 实现须 upsert-then-read,返回最终生效的那个 id(可能不是本次新建的那个)。
  create(seed: TokenSeed, refs: readonly TokenRef[]): Promise<string>;

  // 给已有 Token 加一条 ref(多链归一走这里)。已存在则不动;同样返回该 ref 最终指向的 id。
  linkRef(tokenId: string, ref: TokenRef): Promise<string>;

  // 合并:把 `from` 并进 `into` —— ref 改指、**历史快照的 token_id 一并改指**、旧行删除。
  // 身份可变、金额不变:不改历史行的话曲线会在合并那一刻断成两段。
  merge(from: string, into: string): Promise<void>;

  // —— 读路径 ——
  getByIds(ids: readonly string[]): Promise<Map<string, Token>>;
  // 按主键读一行(logo 代理端点用)。**不门控 info TTL**:只要行在就给字节,否则渲染出了
  // 代理 URL 却在这里 404。
  getById(id: string): Promise<Token | undefined>;
  // 当前有价、按市值排名的前 N 个(选币橱窗的兜底;主力是 warm blob,见 cache.ts)。
  listByRank(limit: number): Promise<Token[]>;

  // —— 写元信息 / 价 ——
  // 只填空槽:undefined 的字段不动,已有值的字段也不动(见 TokenInfoPatch)。
  fillInfo(tokenId: string, patch: TokenInfoPatch): Promise<void>;
  putPrices(prices: readonly TokenPriceWrite[], ttlMs: number): Promise<void>;

  // —— 历史日价(时序,按范围查 → 留真表)——
  getDailyPrices(tokenId: string, dayBuckets: readonly number[]): Promise<Map<number, number>>;
  putDailyPrices(
    tokenId: string,
    prices: readonly { dayBucket: number; unitPrice: number }[],
  ): Promise<void>;
}

// —— 全局 contract → coin 映射(ADR 0022)——
// 无 userId:它是公开知识、可整表重建、跟任何用户无关(CLAUDE.md 原则 #6 的受控例外)。
export interface CgkRefStore {
  // 正查,而且只有正查 —— 所以键是完整的 ref 串,不像 token_refs 拆两列。
  lookup(refs: readonly TokenRef[]): Promise<Map<TokenRef, string>>;
  // cron 一天一次整表刷新。四万行量级 → 实现须分批写(D1 `batch()`)。
  // `updatedAt` 用来看哪些行这轮没刷到(下架币);不删行,留着无害。
  putAll(rows: readonly CgkRefRow[], updatedAt: number): Promise<void>;
  // 最近一次成功刷新的时刻;从未刷过 → null(首次部署要手动触发一次)。
  refreshedAt(): Promise<number | null>;
}

// —— per-user KV 缓存 ——
// 只三种键(见 cache.ts):`warm` / `fx:<币种>` / `platform:<键>`。整张删空功能不坏,只是慢一点。
// 它留着 userId 的理由:per-user 缓存只装这个用户实际碰到的(他选的那个币种、他有持仓的那几条链),
// 全局表得装所有人的并集。
export interface CacheStore {
  get(key: string): Promise<CacheEntry | undefined>;
  put(key: string, value: unknown, ttlMs: number): Promise<void>;
}

// 过期不删、读出带 stale —— 与价的 SWR 同一套语义,由调用方决定要不要用旧值。
export interface CacheEntry {
  value: unknown;
  stale: boolean;
}

// —— 上游(网络)——
// 通用层只说 tokenRef 与 token,不外泄任何 vendor 词。当前唯一实现是 CoinGecko(见 src/coingecko/)。
export interface TokenSource {
  // 本源作为**命名者**的名字(如 "coingecko")—— 它产出的 ref 的左段。
  readonly namer: string;
  // top-N markets:一行含价 + 涨跌 + rank + name + logo。
  fetchMarkets(topN: number): Promise<SourceToken[]>;
  // 关键词搜币(用户选币)。
  searchTokens(query: string): Promise<SourceToken[]>;
  // 按已知 ref 批量刷价。
  fetchPrices(refs: readonly TokenRef[]): Promise<Map<TokenRef, SourcePrice>>;
  // 历史价:一 ref 一区间一次调用,升序原始观测点(粒度随上游,按日归一在服务侧做)。
  fetchPriceSeries(ref: TokenRef, fromMs: number, toMs: number): Promise<PricePoint[]>;
  // 兜底单查:`cgk_refs` 里没有的(今天刚上线的币)才走这条。链未收录 / 无此合约 → null。
  fetchByRef(ref: TokenRef): Promise<SourceToken | null>;
  // cron:整份 contract → coin 映射(两个端点 + 一次纯转换,见 coingecko/ref-map.ts)。
  fetchRefMap(): Promise<{ rows: CgkRefRow[]; unmatchedPlatforms: string[] }>;
}

// 上游给出的一个币:它自己的命名 + 元信息 +(可能有的)价。
export interface SourceToken {
  ref: TokenRef;
  symbol: string;
  name: string;
  logo?: string;
  price?: SourcePrice;
}

export interface SourcePrice {
  unitPrice: number;
  change24h?: number;
  marketCapRank?: number;
  asOf: number;
}
