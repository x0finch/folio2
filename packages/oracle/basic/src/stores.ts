import type { Effect, Option } from "effect";
import type {
  ProviderTokenSeed,
  TokenCandidate,
  TokenInfo,
  TokenInfoPatch,
  TokenInfoWrite,
  TokenPriceWrite,
  TokenRecordPrice,
  TokenRef,
  TokenRefHit,
  TokenRefIndexRow,
} from "./types";

// 本地持久化端口。**`Store` = 本地 / `Upstream` = 出网**,看名字就知道这次调用会不会碰网络
// (上游那一面见 upstream.ts;项目原本叫 `Source`,与 `Store` 太像、一眼糊,故改)。
// 实现在别处:D1 在 `@folio/db`(仍是 Promise 形状,由装配点包成 Effect —— 见下),测试用内存假实现。
//
// **错误通道恒 `never`,不是偷懒**(#362 第 4 站):D1 挂了这一层没有人救得了它 —— 今天没有一个
// 调用点 catch 它,行为是整个请求 500。做成 typed error 只会迫使每个调用点写一遍 `catchAll`
// 再把它扔回去。所以 store 的失败走 **defect**(`Effect.promise` 的拒绝),一路冒到 `runPromise`,
// 与今天逐字一致。E 里只放**有人真的会处理**的东西 —— 那是出网(见 upstream.ts 的 `UpstreamError`)。
//
// **只 `import type { Effect }`**:本包被客户端组件 value-import(`SUPPORTED_CURRENCIES` /
// `valuate` / `tokenTicket`),类型 import 会被擦掉,而 `effect` 的运行时值不该有机会进前端 bundle
// (+75 KB gzip)。要拿 Tag(运行时值)的走 `@folio/oracle-basic/ports`,那个入口只有服务端会碰。
//
// **per-user 的 store 已经绑好了 userId,但本层不知道有 userId 这回事** —— 装配点(app)在建
// Layer 时就把它吃掉了。所以下面的方法签名里没有 user 参数:拿错用户在编译期就发生不了。
// 例外是 `GlobalTokenRefIndexStore` —— 它是全局公开知识,本来就与用户无关(ADR 0022)。
//
// 为什么切成四个而不是一个(ADR 0023):info 与价的 TTL 语义不同(长 / 短),混在一个接口里
// 就会在同一个方法里纠缠。切开之后服务层的一次调用只碰一个 store,读什么写什么在签名里看得见。

// —— per-user:代币行的 info facet + ref 行(身份与元信息,长 TTL)——
export interface TokenStore {
  // mint 第一步:一批 tokenRef 里,哪些已经有 Token 了。绝大多数同步都停在这里。
  findByRefs(refs: readonly TokenRef[]): Effect.Effect<Map<TokenRef, TokenRefHit>>;

  // 建一个新 Token 并挂上这些 ref。**幂等**:账户是并发跑的,同一条 ref 会被同时 mint →
  // 实现须 upsert-then-read,返回最终生效的那个 id(可能不是本次新建的那个)。
  create(seed: ProviderTokenSeed, refs: readonly TokenRef[]): Effect.Effect<string>;

  // 给已有 Token 加一条 ref(多链归一走这里)。已存在则不动;同样返回该 ref 最终指向的 id。
  //
  // **真加上了一条 ref 就把 info 标成该刷**(见 `TokenInfo.infoStale`)。这一刻我们拿到了
  // 「这个币的叫法变了」的**证据**:某个来源开始用一个新名字称呼一个我们已经认识的币 ——
  // CoinGecko 把 MATIC 改成 POL、交易所随后也改了代号,两边改的时间还不一致。光靠 TTL 到期
  // (30d)重读的话,收敛之后那一行最长 30 天都显示旧名。**不比较新旧 symbol**:比较要多读一次
  // 行,而标脏的代价只是下一次批量刷多带一个 id(本来就要发那一次请求)。
  // 早退的两条路(ref 已有主 / 该 Token 在该命名者下已有别的叫法)不写、也就不标。
  linkRef(tokenId: string, ref: TokenRef): Effect.Effect<string>;

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
  //
  // 与 `linkRef` 同理:**赢家的 info 一并标成该刷**。两行会合并,正说明至少有一边的名字与
  // 上游当前的叫法不一致 —— 赢家留的是自己那份,可能就是旧的那份。
  merge(from: string, into: string): Effect.Effect<void>;

  // 读:按内部 id 批量 / 按主键单读。**不门控 info TTL** —— 只要行在就给,否则渲染出了
  // logo 代理 URL 却在端点上 404。
  getByIds(ids: readonly string[]): Effect.Effect<Map<string, TokenInfo>>;
  // 单读回 `Option` 而不是 `A | undefined`:「没有这一行」是调用方必须分支的一档
  // (`priceSeries` / `logoUrlById` 都靠它早退),用 Option 就不会有人忘了那个分支。
  getById(id: string): Effect.Effect<Option.Option<TokenInfo>>;

  // 只填空槽:undefined 的字段不动,已有值的字段也不动(见 TokenInfoPatch)。
  // 用在「归一到已有 Token」那一步:那一行的元信息可能来自上游,连接器报的不该盖掉它。
  fillInfo(tokenId: string, patch: TokenInfoPatch): Effect.Effect<void>;

  // **覆盖**上游那三个字段 + 续 info TTL。与 `fillInfo` 的填空槽相反,这里上游说了算:
  // 链上合约的 symbol 是部署者写的、可能与上游实际叫法不一致(MATIC→POL),不覆盖的话
  // 同一个币在链上侧与交易所侧会显示成两个名字。只对**已认出来**的行调(ref 非空)。
  putInfo(rows: readonly TokenInfoWrite[], ttlMs: number): Effect.Effect<void>;

  // 符号消歧候选:按 symbol 找当前上游认识的币。**不是**从这里生的数据 —— warm 集的子集,
  // 由服务层从 cache 的 warm blob 筛出后交给消歧(见 entry/cache.ts);此处只为
  // 「本地已认识的同名币」留一条路,实现可直接查 ref 行。
  candidatesBySymbol(symbol: string): Effect.Effect<TokenCandidate[]>;
}

// —— per-user:价 facet + 历史日价(短 TTL;「价」是一类,共用同一套 SWR 编排)——
export interface TokenPriceStore {
  getByIds(ids: readonly string[]): Effect.Effect<Map<string, TokenRecordPrice>>;
  // 过期不删,读出带 stale。
  put(prices: readonly TokenPriceWrite[], ttlMs: number): Effect.Effect<void>;

  // 历史日价(时序、按范围查 → 真表)。过去某 UTC 日的价不可变 → 永久缓存,无 TTL。
  getDaily(tokenId: string, dayBuckets: readonly number[]): Effect.Effect<Map<number, number>>;
  putDaily(
    tokenId: string,
    prices: readonly { dayBucket: number; unitPrice: number }[],
  ): Effect.Effect<void>;

  // 历史日价的**按 ref 直读**变体(法币历史汇率,ADR 0026)。跳过 `getDaily` 的 tokenId→ref
  // 翻译,直接拿全局键读写 `token_daily_prices`。为什么必须绕开翻译:法币身份(`fiat/issued:CODE`)
  // 与 BTC 反算腿(`coingecko/issued:bitcoin`,某些用户没持有它 → 没有那一档 ref 行)在 per-user
  // `token_refs` 里查不到,`getDaily` 会当「还没认出来」返回空。写、读因此对称地按 ref 直接落表 ——
  // token_daily_prices 本就是全局键值(#199/ADR 0022 的受控例外),按任意 ref 存取都合法。
  getDailyByRef(ref: TokenRef, dayBuckets: readonly number[]): Effect.Effect<Map<number, number>>;
  putDailyByRef(
    ref: TokenRef,
    prices: readonly { dayBucket: number; unitPrice: number }[],
  ): Effect.Effect<void>;
}

// —— 全局:`global_token_ref_index`(ADR 0022)——
// 无 userId:公开知识、可整表重建、跟任何用户无关(CLAUDE.md 原则 #6 的受控例外)。
export interface GlobalTokenRefIndexStore {
  // 正查一批:上游 `upstream` 对这些**链上** ref 的整条叫法。miss 的键不出现。
  // 值是**整条** upstream ref(coingecko/issued:bitcoin),不是半截 —— 调用方拿来直接用,不再拼装(#228)。
  lookup(upstream: string, chainRefs: readonly TokenRef[]): Effect.Effect<Map<TokenRef, TokenRef>>;
  // cron 一天一次整份刷新。四万行量级 → 实现须分批写(D1 `batch()`)。
  // `updatedAt` 用来看哪些行这轮没刷到(下架币);不删行,留着无害。
  putAll(rows: readonly TokenRefIndexRow[], updatedAt: number): Effect.Effect<void>;
  // 上游 `upstream` 最近一次成功刷新的时刻;从未刷过 → `Option.none()`(首次部署要手动触发一次)。
  refreshedAt(upstream: string): Effect.Effect<Option.Option<number>>;
}

// —— per-user KV 缓存 ——
// 只三种键(见 entry/cache.ts):`warm` / `fx:<币种>` / `platform:<键>`。
// 整张删空功能不坏,只是慢一点。它留着 userId 的理由:per-user 缓存只装这个用户实际碰到的
// (他选的那个币种、他有持仓的那几条链),全局表得装所有人的并集。
// **批量与单键都有**,同 `TokenStore` 的 `getByIds` / `getById`。批量不是优化而是这一层的常态:
// 展示一次要这个用户的全部平台,预热一次写十来个币种的汇率 —— 逐键往返会把 1 次 D1 变成 N 次,
// 而且那 N 次落在总览的读路径上。TTL 按键给,所以「命中长、否定短」这种区分不需要绕开端口。
export interface CacheStore {
  get(key: string): Effect.Effect<Option.Option<CacheEntry>>;
  // miss 的键不出现在结果里(同 `findByRefs` 的口径)。
  getMany(keys: readonly string[]): Effect.Effect<Map<string, CacheEntry>>;
  put(key: string, value: unknown, ttlMs: number): Effect.Effect<void>;
  // 一次写多个键,各带自己的 TTL。实现须**一个批次**发出去(D1 `batch()`)。
  putMany(writes: readonly CacheWrite[]): Effect.Effect<void>;
}

export interface CacheWrite {
  key: string;
  value: unknown;
  ttlMs: number;
}

// 过期不删、读出带 stale —— 与价的 SWR 同一套语义,由调用方决定要不要用旧值。
export interface CacheEntry {
  value: unknown;
  stale: boolean;
}
