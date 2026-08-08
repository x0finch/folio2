import type { UpstreamError } from "@folio/client-core";
import type { Effect } from "effect";
import type { PlatformMeta } from "./platform";
import type { TokenPrice, TokenPricePoint, TokenRef, TokenRefIndexRow } from "./types";

// 上游端口(网络)。沿用现有的**按能力分面**做法(`oracle-basic/src/token.ts` 就是这么分的),
// 并给它加上第三面 —— 全局映射的整份拉取。
//
// **契约层不知道上游是谁**:实现由 app 在装配时以 Layer 注入(ADR 0023),`dependencies` 里
// 没有任何 client / upstream 包。所以这里没有 apiKey、没有端点、没有 DTO —— 那些都在
// `@folio/oracle-upstream-coingecko` 里。通用层只说「我们的 chain 标识」;各 upstream 内部把它
// 翻成自家的寻址命名,不外泄。价格一律 USD。
//
// **错误面复用 `@folio/client-core` 的四类 tagged error**(凭据 / 限流 / 够不到 / 读不动),
// 不给参考层再造一套:划分依据是「消费者要区分什么」,而本层的消费者对四类的处理是同一个
// (降级到本地旧值)—— 另立一套只会多 4 个同构类 + 一份映射(CODING.md「错误」一节)。
// 它换来的是**精确的降级**:今天那 6 处 `catch {}` 连自己的解析 bug 一起吞,改成按 tag 接之后
// 「上游挂了」被吞、「代码写错了」照样炸。
//
// **`R` 是 `never`,传输层不外泄**:adapter 的 Layer 自己把 client 与 `HttpClient` 提供掉,
// 于是服务层的 `R` 里只有端口本身,不会长出一条 `Outbound`。谁提供这个端口是谁的事。
//
// 只 `import type { Effect }` 的理由同 stores.ts(本包会被客户端 value-import)。

// 适配器自报的标识,与 `BalanceProvider.id` 同款(小写 slug)。
// 它同时就是本源产出的 tokenRef 的 **namer**,以及全局映射表里的 `namer` 列。
interface UpstreamIdentity {
  readonly id: string;
}

// 当前上游的**命名身份** —— `id`(= 它产出的 tokenRef 的 namer,也是全局映射表的 `namer` 列)
// 加上它那张策展小表。**独立成一个端口,不是 `TokenUpstream` 的一面**,理由是写路径:
// mint 需要这两样,但 mint「全程不碰网络」是**类型事实**而不是约定 —— 让它依赖整个
// `TokenUpstream` 就等于把读路径的网络面接进了写路径(#216 那个坑的复刻)。
//
// `overrides`:symbol → **该上游的** coin id(majors + 已知撞名),优先于市值排名,防山寨撞名。
// 它逐条写的都是某一家的 id,所以归 adapter 提供 —— 迁移前它是 `OracleConfig.overrides`
// 一个配置字段,由装配点从 adapter 搬到服务层;现在 adapter 的 Layer 直接给,少一次搬运。
export interface Namer {
  readonly id: string;
  readonly overrides: Readonly<Record<string, string>>;
}

// 目录 / 发现面:top-N 预热 + 关键词搜索(都需要完整币目录)。
export interface TokenMetaUpstream extends UpstreamIdentity {
  // 一行含价 + 涨跌 + rank + name + logo;喂 warm blob。
  fetchMarkets(opts: { topN: number }): Effect.Effect<UpstreamToken[], UpstreamError>;
  // 按关键词搜币(用户选币消歧)。
  searchTokens(query: string): Effect.Effect<UpstreamToken[], UpstreamError>;
}

// 点查面:按已知 ref 刷价 / 取历史。不需要币目录。
export interface PriceUpstream extends UpstreamIdentity {
  fetchPrices(refs: readonly TokenRef[]): Effect.Effect<Map<TokenRef, TokenPrice>, UpstreamError>;
  // 按已知 ref 批量取**整行**(symbol / name / logo,可能连价)。
  //
  // 为什么需要它而不是只有 fetchPrices:**上游是这三个字段的权威 home**。代币行是用连接器报的
  // 元信息建起来的,而链上合约的 symbol 是部署者写在合约里的字符串 —— 可能过时(MATIC 改名 POL
  // 之后,链上那份还写着 MATIC),也可能压根与上游的叫法不一致。而合约那条 ref 是**按地址**认出来的,
  // 认定本身可信;错的只是显示用的名字。于是同一个币在链上与交易所两侧显示成两个名字。
  // 认出来之后拿上游那份覆盖一遍,这个歧义就没了。
  //
  // 未收录的 ref 不出现在结果里(不是报错)。
  fetchTokens(refs: readonly TokenRef[]): Effect.Effect<UpstreamToken[], UpstreamError>;
  // 一 ref 一区间**一次**上游调用,升序原始观测点(粒度随上游;按日归一在服务层做)。
  // `vsCurrency` 缺省 USD(全仓价一律 USD);法币历史汇率从 BTC 反算时(ADR 0026),用它取
  // 「BTC 在某法币下的历史价」那条腿(`vsCurrency = <code>`)—— 复用这一个取数口,不另立方法。
  fetchPriceSeries(
    ref: TokenRef,
    fromMs: number,
    toMs: number,
    vsCurrency?: string,
  ): Effect.Effect<TokenPricePoint[], UpstreamError>;
}

// 全局映射面:整份「链上 ref → 本源的叫法」。cron 一天一次(ADR 0022)。
export interface TokenRefIndexUpstream extends UpstreamIdentity {
  fetchRefIndex(): Effect.Effect<RefIndexFetch, UpstreamError>;
}

// 完整代币上游 = 三面之交。当前唯一实现是 CoinGecko adapter。
export type TokenUpstream = TokenMetaUpstream & PriceUpstream & TokenRefIndexUpstream;

// 汇率面(展示币种)。**一次拉全,没有按币种点查** —— 支持的币种就那十来个,而上游那个端点
// 本来也是一把全给;拆成点查等于同一份数据拉十二遍。
//
// **它不是 `TokenUpstream` 的一面**,而是独立一个端口:汇率与「这是哪个币」毫无关系,
// 完全可以由另一家提供(ADR 0023 的可换源就是这个意思)。装配点因此各给一个 Layer,
// 当前恰好都指向同一个 CoinGecko adapter。
export interface FxUpstream extends UpstreamIdentity {
  // 币种 code(大写)→ usdPerUnit。上游不认识的币种不出现在结果里(不是报错)。
  fetchRates(): Effect.Effect<Map<string, number>, UpstreamError>;

  // 该源里 BTC 的 tokenRef —— 汇率的 **BTC 反算基**(ADR 0026)。`fetchRates` 本就是 BTC 派生
  // (`/exchange_rates` 以 BTC 为基),历史汇率同源:`usd_per_unit(code)@日 = BTC美元@日 ÷ BTC该币@日`,
  // 两条腿都用 `PriceUpstream.fetchPriceSeries(btcRef, …, vsCurrency)` 取(不另立取数方法)。
  // 它也是 `token_daily_prices` 里 BTC 美元历史腿的键(`coingecko/issued:bitcoin`)—— 与
  // `tokens.priceSeries` 落的 BTC 历史价共用同一批全局行,服务层按它对称读写、复用且顺带暖。
  readonly btcRef: TokenRef;
}

// 平台面(链的名与图)。同样独立成端口 —— 它跟代币、跟汇率都不是一件事。
//
// **只有整张链表,没有按 key 单查。** 上游那边它本来就是一个端点一把全给,而我们要的键
// (`evm:1` / `solana`)一次也就那么几个。原来还有一个「按 key 单查场馆」的面 ——
// 场馆键从 ADR 0020 起就不带 `exchange:` / `perp:` 前缀了(命名者是裸 slug),
// 那条路因此再也走不到,搬家时不带走。
export interface PlatformUpstream extends UpstreamIdentity {
  // 每条链产短形 slug;有数字 chainId 的再产一条 `evm:<id>`(两种 platformKey 都覆盖)。
  fetchChains(): Effect.Effect<PlatformMeta[], UpstreamError>;
}

// 上游给出的一个币:它自己的命名 + 元信息 +(可能有的)价。
// 与 `TokenInfo` 的区别:上游结果还没进库,所以没有内部 id、`ref` 必然非空。
//
// `marketCapRank` 独立于 `price`:markets 端点两样都给(rank 也在 `price.marketCapRank` 里,
// 给消歧/候选用),但 `/search` 只给 rank、不给价 —— 那条路要带 rank 就只能挂在这个顶层字段。
// 展示侧(选币下拉徽标)统一读这里,不管这个币是从哪个端点来的。
export interface UpstreamToken {
  ref: TokenRef;
  symbol: string;
  name: string;
  logo?: string;
  marketCapRank?: number;
  price?: TokenPrice;
}

// 整份映射的拉取结果。**失配要喊出来**:我们指名要的某条链在上游的平台表里查无此项,
// 后果是那条链上的币全都没价没图**而且不报错** —— 静默故障必须有出口(ADR 0022)。
export interface RefIndexFetch {
  rows: TokenRefIndexRow[];
  unmatchedPlatforms: string[]; // 我们要的链,上游没有 → 告警
  skipped: number; // 上游有、我们不追踪的链 → 纯计数,正常且数目很大
}
