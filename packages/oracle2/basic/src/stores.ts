import type {
  ProviderTokenSeed,
  TokenCandidate,
  TokenInfo,
  TokenInfoPatch,
  TokenPriceWrite,
  TokenRecordPrice,
  TokenRef,
  TokenRefHit,
  TokenRefIndexRow,
} from "./types";

// 本地持久化端口。**`Store` = 本地 / `Upstream` = 出网**,看名字就知道这次调用会不会碰网络
// (上游那一面见 upstream.ts;项目原本叫 `Source`,与 `Store` 太像、一眼糊,故改)。实现在别处(D1 在 `@folio/db`,测试用内存假实现)。
//
// **per-user 的 store 已经绑好了 userId,但本层不知道有 userId 这回事** —— `oracleFor(userId)`
// 在工厂那一层就把它吃掉了。所以下面的方法签名里没有 user 参数:拿错用户在编译期就发生不了。
// 例外是 `GlobalTokenRefIndexStore` —— 它是全局公开知识,本来就与用户无关(ADR 0022)。
//
// 为什么切成四个而不是一个(ADR 0023):info 与价的 TTL 语义不同(长 / 短),混在一个接口里
// 就会在同一个方法里纠缠。切开之后服务层的一次调用只碰一个 store,读什么写什么在签名里看得见。

// —— per-user:代币行的 info facet + ref 行(身份与元信息,长 TTL)——
export interface TokenStore {
  // mint 第一步:一批 tokenRef 里,哪些已经有 Token 了。绝大多数同步都停在这里。
  findByRefs(refs: readonly TokenRef[]): Promise<Map<TokenRef, TokenRefHit>>;

  // 建一个新 Token 并挂上这些 ref。**幂等**:账户是并发跑的,同一条 ref 会被同时 mint →
  // 实现须 upsert-then-read,返回最终生效的那个 id(可能不是本次新建的那个)。
  create(seed: ProviderTokenSeed, refs: readonly TokenRef[]): Promise<string>;

  // 给已有 Token 加一条 ref(多链归一走这里)。已存在则不动;同样返回该 ref 最终指向的 id。
  linkRef(tokenId: string, ref: TokenRef): Promise<string>;

  // 合并:把 `from` 并进 `into` —— ref 改指、**历史快照的 token_id 一并改指**、旧行删除。
  // 身份可变、金额不变:不改历史行的话曲线会在合并那一刻断成两段。
  //
  // **`from` 的价与历史日价不用搬**,但两者的理由不同(#199 定案后修正):
  //   · **现价**在代币行自己那一列上,删行自然带走。
  //   · **历史日价**按 tokenRef 全局存(与 `token_id` 没有外键关系)—— 什么都不用删,而且
  //     两个 Token 会被合并,正是因为它们指向同一条上游 ref → 赢家读的就是同一批行,
  //     **曲线一格都不缺**。
  // 实现要保证的是另一件事:`token_refs` 的 `token_id` 外键带 `ON DELETE CASCADE`,
  // 否则删掉旧代币行会留下指向不存在 Token 的 ref 行。
  merge(from: string, into: string): Promise<void>;

  // 读:按内部 id 批量 / 按主键单读。**不门控 info TTL** —— 只要行在就给,否则渲染出了
  // logo 代理 URL 却在端点上 404。
  getByIds(ids: readonly string[]): Promise<Map<string, TokenInfo>>;
  getById(id: string): Promise<TokenInfo | undefined>;

  // 只填空槽:undefined 的字段不动,已有值的字段也不动(见 TokenInfoPatch)。
  fillInfo(tokenId: string, patch: TokenInfoPatch): Promise<void>;

  // 符号消歧候选:按 symbol 找当前上游认识的币。**不是**从这里生的数据 —— warm 集的子集,
  // 由服务层从 cache 的 warm blob 筛出后交给消歧(见 services/cache.ts);此处只为
  // 「本地已认识的同名币」留一条路,实现可直接查 ref 行。
  candidatesBySymbol(symbol: string): Promise<TokenCandidate[]>;
}

// —— per-user:价 facet + 历史日价(短 TTL;「价」是一类,共用同一套 SWR 编排)——
export interface TokenPriceStore {
  getByIds(ids: readonly string[]): Promise<Map<string, TokenRecordPrice>>;
  // 过期不删,读出带 stale。
  put(prices: readonly TokenPriceWrite[], ttlMs: number): Promise<void>;

  // 历史日价(时序、按范围查 → 真表)。过去某 UTC 日的价不可变 → 永久缓存,无 TTL。
  getDaily(tokenId: string, dayBuckets: readonly number[]): Promise<Map<number, number>>;
  putDaily(
    tokenId: string,
    prices: readonly { dayBucket: number; unitPrice: number }[],
  ): Promise<void>;
}

// —— 全局:`global_token_ref_index`(ADR 0022)——
// 无 userId:公开知识、可整表重建、跟任何用户无关(CLAUDE.md 原则 #6 的受控例外)。
export interface GlobalTokenRefIndexStore {
  // 正查一批:某个命名者对这些链上 ref 的叫法。miss 的键不出现。
  lookup(namer: string, refs: readonly TokenRef[]): Promise<Map<TokenRef, string>>;
  // cron 一天一次整份刷新。四万行量级 → 实现须分批写(D1 `batch()`)。
  // `updatedAt` 用来看哪些行这轮没刷到(下架币);不删行,留着无害。
  putAll(rows: readonly TokenRefIndexRow[], updatedAt: number): Promise<void>;
  // 某个命名者最近一次成功刷新的时刻;从未刷过 → null(首次部署要手动触发一次)。
  refreshedAt(namer: string): Promise<number | null>;
}

// —— per-user KV 缓存 ——
// 只三种键(见 services/cache.ts):`warm` / `fx:<币种>` / `platform:<键>`。
// 整张删空功能不坏,只是慢一点。它留着 userId 的理由:per-user 缓存只装这个用户实际碰到的
// (他选的那个币种、他有持仓的那几条链),全局表得装所有人的并集。
export interface CacheStore {
  get(key: string): Promise<CacheEntry | undefined>;
  put(key: string, value: unknown, ttlMs: number): Promise<void>;
}

// 过期不删、读出带 stale —— 与价的 SWR 同一套语义,由调用方决定要不要用旧值。
export interface CacheEntry {
  value: unknown;
  stale: boolean;
}
