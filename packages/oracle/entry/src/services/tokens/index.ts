import {
  CacheStore,
  GlobalTokenRefIndexStore,
  Namer,
  TokenPriceStore,
  TokenStore,
  TokenUpstream,
} from "@folio/oracle-basic/ports";
import { Context, Effect, Layer } from "effect";
import { CandidateSource } from "./candidates";
import { makeCatalogue, type TokenCatalogue } from "./catalogue";
import { makeHistory, type TokenHistory } from "./history";
import { type MintInput, makeMinting, type TokenMinting } from "./mint";
import { makePricing, type TokenPricing } from "./price";
import { makeReading, type TokenReading } from "./read";
import { makeStaleRefresh, type RefreshStaleReport, type TokenStaleRefresh } from "./stale";

// 代币这个领域的门面 —— **一个服务,六片实现**。本文件只有三样东西:拼出来的接口、Tag、装配。
//
// **为什么是一个服务。** 以前是两个(`TokenReader` / `TokenMinter`),按「读路径 / 写路径」分,
// 而那条线名不副实:「读」那半自己就在写(刷价与元信息、落历史日价、重写橱窗 blob)。
// 真正的那条线是**「这是哪个币」何时定死** —— `mint` 在写快照之前把身份定死并冻进去,其余
// 一律拿 token_id 直接取数(ADR 0021)。那是**语义**,由 `mint` 这个方法名表达,不必再切一个 Tag。
//
// **为什么拆成六个文件。** 一个服务 12 个方法、四百来行,读的人要先滚过全部才敢动一个。
// 拆的判据是**「谁在问、问的是什么」**,每片自带接口片段与那一片的判据:
//
//   `./mint`       写   tokenRef → token_id,身份在此定死。**全程不出网**(那条红线在文件里)
//   `./read`       读   富化 / 取图 —— 零网络,拿 id 直接取整行
//   `./price`      读   现价,按「有没有内部 id」分两档(写回 vs 不建行)
//   `./history`    读   历史日价 —— 过去日不可变落库、今日桶恒现取
//   `./stale`      写   唯一覆盖写既有行的地方(价 + 元信息各一条上游端点)
//   `./catalogue`  读   世上有哪些币(公开目录,与用户无关)—— 一个 store 都不碰
//
// 另三件是这一片专属的内部件,不属于任何方法但只被这里用:`./warm`(那份 blob 本身)、
// `./candidates`(mint 的 symbol 那一档,包内 Tag)、`./confidence`(它的判官)。
// 它们本来在 `../../internal/`,但那个目录的意思是「本包共用」,而这三件只有代币用得上 ——
// 留在那儿会让读的人以为 fx / platforms 也在用。**`internal/` 现在只剩真正三家共用的两件**:
// `degrade`(降级 + 记一行)与 `refresh`(SWR 组合子 —— 它今天只有代币在用,但它领域中立,
// 是「读本地 → 判 stale → 回源 → 写回」的通用编排,ADR 0023 就是这么定位它的)。
//
// **接口用 `extends` 拼**而不是在这里重抄一遍 12 个签名:每个方法的文档跟着它的实现走,
// 改实现的人一定看得见它,而抄一遍的那份迟早与实现对不上。
export interface TokenService
  extends TokenMinting,
    TokenReading,
    TokenPricing,
    TokenHistory,
    TokenStaleRefresh,
    TokenCatalogue {}

export const TokenService = Context.GenericTag<TokenService>("oracle/TokenService");

export type { MintInput, RefreshStaleReport };

// **`now` 那个 config 字段没了** —— 时间从 `Clock` 取,测试用 `TestClock` 推。
// 判据是 CODING.md 那条:只有测试会传的字段,就不该是字段(它当初有 5 个默认值散在各处)。
//
// 从 Tag 取服务**只发生在这里**:六片工厂全都收已解析好的端口对象,所以它们的 `R` 是 `never`
// (与 `./warm` 同款),服务的方法签名不会把自己的依赖漏给调用方。
const make = Effect.gen(function* () {
  const store = yield* TokenStore;
  const prices = yield* TokenPriceStore;
  const cache = yield* CacheStore;
  const upstream = yield* TokenUpstream;

  // mint 那三个额外依赖。**这里是它们唯一一次与上游同处一个作用域** —— 再往下就交给
  // `makeMinting`,而它的 `MintDeps` 里一个上游都没有(`./mint` 的红线)。
  const refIndex = yield* GlobalTokenRefIndexStore;
  const candidates = yield* CandidateSource;
  const namer = yield* Namer;

  // 每片只拿它真正要的端口 —— 这一行就是那张依赖表:`read` 不碰上游、`catalogue` 不碰 store。
  return {
    ...makeMinting({ store, refIndex, candidates, namer }),
    ...makeReading(store, prices),
    ...makePricing(store, prices, upstream),
    ...makeHistory(store, prices, upstream),
    ...makeStaleRefresh(store, prices, upstream),
    ...makeCatalogue(cache, upstream),
  } satisfies TokenService;
});

// `CandidateSource` 留在这条 `R` 上,由 `../../layer` 在装配时喂进来并**吃掉** —— 于是装配点
// 的 `R` 里看不到它(它是包内 Tag,从不出包),而顶掉它仍然只需换一个 layer,不必另开一条
// 构造路(见 `./candidates` 里那段「注入缝」)。
export const tokenServiceLayer: Layer.Layer<
  TokenService,
  never,
  | TokenStore
  | TokenPriceStore
  | CacheStore
  | TokenUpstream
  | GlobalTokenRefIndexStore
  | Namer
  | CandidateSource
> = Layer.effect(TokenService, make);
