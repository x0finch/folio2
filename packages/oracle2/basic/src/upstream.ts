import type { PlatformMeta } from "./platform";
import type { TokenPrice, TokenPricePoint, TokenRef, TokenRefIndexRow } from "./types";

// 上游端口(网络)。沿用现有的**按能力分面**做法(`oracle-basic/src/token.ts` 就是这么分的),
// 并给它加上第三面 —— 全局映射的整份拉取。
//
// **契约层不知道上游是谁**:实现由 app 在初始化时注入(与 store 同款惰性工厂,ADR 0023),
// `dependencies` 里没有任何 client / upstream 包。所以这里没有 apiKey、没有端点、没有 DTO ——
// 那些都在 `@folio/oracle2-upstream-coingecko` 里。
// 通用层只说「我们的 chain 标识」;各 upstream 内部把它翻成自家的寻址命名,不外泄。价格一律 USD。

// 适配器自报的标识,与 `BalanceProvider.id` 同款(小写 slug)。
// 它同时就是本源产出的 tokenRef 的 **namer**,以及全局映射表里的 `namer` 列。
interface UpstreamIdentity {
  readonly id: string;
}

// 目录 / 发现面:top-N 预热 + 关键词搜索(都需要完整币目录)。
export interface TokenMetaUpstream extends UpstreamIdentity {
  // 一行含价 + 涨跌 + rank + name + logo;喂 warm blob。
  fetchMarkets(opts: { topN: number }): Promise<UpstreamToken[]>;
  // 按关键词搜币(用户选币消歧)。
  searchTokens(query: string): Promise<UpstreamToken[]>;
}

// 点查面:按已知 ref 刷价 / 取历史 / 按 (chain, contract) 单查。不需要币目录。
export interface PriceUpstream extends UpstreamIdentity {
  fetchPrices(refs: readonly TokenRef[]): Promise<Map<TokenRef, TokenPrice>>;
  // 按已知 ref 批量取**整行**(symbol / name / logo,可能连价)。
  //
  // 为什么需要它而不是只有 fetchPrices:**上游是这三个字段的权威 home**。代币行是用连接器报的
  // 元信息建起来的,而链上合约的 symbol 是部署者写在合约里的字符串 —— 可能过时(MATIC 改名 POL
  // 之后,链上那份还写着 MATIC),也可能压根与上游的叫法不一致。而合约那条 ref 是**按地址**认出来的,
  // 认定本身可信;错的只是显示用的名字。于是同一个币在链上与交易所两侧显示成两个名字。
  // 认出来之后拿上游那份覆盖一遍,这个歧义就没了。
  //
  // 未收录的 ref 不出现在结果里(不是报错)。
  fetchTokens(refs: readonly TokenRef[]): Promise<UpstreamToken[]>;
  // 一 ref 一区间**一次**上游调用,升序原始观测点(粒度随上游;按日归一在服务层做)。
  fetchPriceSeries(ref: TokenRef, fromMs: number, toMs: number): Promise<TokenPricePoint[]>;
  // 兜底单查:全局映射里没有的(今天刚上线的币)才走这条。链未收录 / 无此合约 → null。
  fetchByContract(chain: string, contract: string): Promise<UpstreamToken | null>;
}

// 全局映射面:整份「链上 ref → 本源的叫法」。cron 一天一次(ADR 0022)。
export interface TokenRefIndexUpstream extends UpstreamIdentity {
  fetchRefIndex(): Promise<RefIndexFetch>;
}

// 完整代币上游 = 三面之交。当前唯一实现是 CoinGecko adapter。
export type TokenUpstream = TokenMetaUpstream & PriceUpstream & TokenRefIndexUpstream;

// 汇率面(展示币种)。**一次拉全,没有按币种点查** —— 支持的币种就那十来个,而上游那个端点
// 本来也是一把全给;拆成点查等于同一份数据拉十二遍。
//
// **它不是 `TokenUpstream` 的一面**,而是独立一个端口:汇率与「这是哪个币」毫无关系,
// 完全可以由另一家提供(ADR 0023 的可换源就是这个意思)。装配点因此收两个上游工厂,
// 当前恰好都指向同一个 CoinGecko adapter。
export interface FxUpstream extends UpstreamIdentity {
  // 币种 code(大写)→ usdPerUnit。上游不认识的币种不出现在结果里(不是报错)。
  fetchRates(): Promise<Map<string, number>>;
}

// 平台面(链的名与图)。同样独立成端口 —— 它跟代币、跟汇率都不是一件事。
//
// **只有整张链表,没有按 key 单查。** 上游那边它本来就是一个端点一把全给,而我们要的键
// (`evm:1` / `solana`)一次也就那么几个。原来还有一个「按 key 单查场馆」的面 ——
// 场馆键从 ADR 0020 起就不带 `exchange:` / `perp:` 前缀了(命名者是裸 slug),
// 那条路因此再也走不到,搬家时不带走(见本片 PR 说明)。
export interface PlatformUpstream extends UpstreamIdentity {
  // 每条链产短形 slug;有数字 chainId 的再产一条 `evm:<id>`(两种 platformKey 都覆盖)。
  fetchChains(): Promise<PlatformMeta[]>;
}

// 上游给出的一个币:它自己的命名 + 元信息 +(可能有的)价。
// 与 `TokenInfo` 的区别:上游结果还没进库,所以没有内部 id、`ref` 必然非空。
export interface UpstreamToken {
  ref: TokenRef;
  symbol: string;
  name: string;
  logo?: string;
  price?: TokenPrice;
}

// 整份映射的拉取结果。**失配要喊出来**:我们指名要的某条链在上游的平台表里查无此项,
// 后果是那条链上的币全都没价没图**而且不报错** —— 静默故障必须有出口(ADR 0022)。
export interface RefIndexFetch {
  rows: TokenRefIndexRow[];
  unmatchedPlatforms: string[]; // 我们要的链,上游没有 → 告警
  skipped: number; // 上游有、我们不追踪的链 → 纯计数,正常且数目很大
}
