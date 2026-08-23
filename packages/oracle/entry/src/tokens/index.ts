import {
  CacheStore,
  GlobalTokenRefIndexStore,
  Namer,
  TokenPriceStore,
  TokenStore,
  TokenUpstream,
} from "@folio/oracle-basic/ports";
import { Effect } from "effect";
import { CandidateSource } from "./candidates";
import { makeCatalogue, type TokenCatalogue } from "./catalogue";
import { makeHistory, type TokenHistory } from "./history";
import { type MintInput, makeMinting, type TokenMinting } from "./mint";
import { makePricing, makeReading, type TokenPricing, type TokenReading } from "./price";
import { makeStaleRefresh, type RefreshStaleReport, type TokenStaleRefresh } from "./stale";

// 代币这个领域的门面 —— **一个服务,五片实现**。本文件只有两样东西:拼出来的形状、服务本身。
//
// **为什么是一个服务。** 以前是两个(`TokenReader` / `TokenMinter`),按「读路径 / 写路径」分,
// 而那条线名不副实:「读」那半自己就在写(刷价与元信息、落历史日价、重写橱窗 blob)。
// 真正的那条线是**「这是哪个币」何时定死** —— `mint` 在写快照之前把身份定死并冻进去,其余
// 一律拿 token_id 直接取数(ADR 0021)。那是**语义**,由 `mint` 这个方法名表达,不必再切一个 Tag。
//
// **为什么拆成这些文件。** 判据是**「谁在问、问的是什么」**,每片自带接口片段与那一片的判据:
//
//   `./mint`       写   tokenRef → token_id,身份在此定死。**全程不出网**(那条红线在文件里)
//   `./price`      读   整行富化 + 现价(按「有没有内部 id」分两档)
//   `./history`    读   历史日价 —— 过去日不可变落库、今日桶恒现取
//   `./stale`      写   唯一覆盖写既有行的地方(价 + 元信息各一条上游端点)
//   `./catalogue`  读   世上有哪些币(公开目录,与用户无关)—— 一个 store 都不碰
//
// 另外三件不是方法,是这个文件夹里的零件,**都不从这个 index 出去**:
//   `./warm`        市值前 N 的那份 blob(三个读者共用一份,判据各不同 —— 见它的开头)
//   `./candidates`  mint 的 symbol 那一档要问的候选源(包内 Tag,`../oracle` 装配时吃掉)
//   `./swr`         SWR 组合子 + 降级(读本地 → 判 stale → 回源 → 写回,ADR 0023)
//
// 前两件只有代币用得上。**`./swr` 领域中立,住这里是将就** —— `../fx` 与 `../platforms`
// 也在用,于是它们得从代币这个文件夹里 import 一个跟代币无关的东西。曾经独占 `internal/`,
// 但那个目录里大半只有代币在用。哪天用法开始分化,再提回共用位置。
//
// **形状用 `extends` 拼**而不是在这里重抄一遍签名:每个方法的文档跟着它的实现走,
// 改实现的人一定看得见它,而抄一遍的那份迟早与实现对不上。服务本身是个 class
// (`Effect.Service`,#501),它的类型由下面 `make` 的返回值定 —— `TokenServiceShape` 只是给
// 那个返回值一个可校验的名字,不出这个文件,也不是第二份签名复述。
interface TokenServiceShape
  extends TokenMinting,
    TokenReading,
    TokenPricing,
    TokenHistory,
    TokenStaleRefresh,
    TokenCatalogue {}

export type { MintInput, RefreshStaleReport };

// **维护那张全局映射表的两个 cron 任务不在这里**(`../global-ref-index`),虽然读它的正是
// 隔壁 `./mint`(`globalRefIndex.lookup` 那一句)。理由是本文件夹里的一切都归 `TokenService`,
// 而那个服务是 **per-user** 的:它的 `R` 里有三张要 userId 才建得出来的 store。
// 把那两件收进来就等于逼 cron 编一个假 userId 去建三张它根本不会碰的 store,而
// 「没有 userId 就构造不出 per-user 的东西」正是那条隔离保证的实现方式(原则 #6 / ADR 0022)。
// 文件名里的 `global-` 就是在说这件事:它跟「谁的」无关,所以它不住在按用户切的这一边。

// **`now` 那个 config 字段没了** —— 时间从 `Clock` 取,测试用 `TestClock` 推。
// 判据是 CODING.md 那条:只有测试会传的字段,就不该是字段(它当初有 5 个默认值散在各处)。
//
// 从 Tag 取服务**只发生在这里**:五片工厂全都收已解析好的端口对象,所以它们的 `R` 是 `never`
// (与 `./warm` 同款),服务的方法签名不会把自己的依赖漏给调用方。
const make = Effect.gen(function* () {
  const store = yield* TokenStore;
  const prices = yield* TokenPriceStore;
  const cache = yield* CacheStore;
  const upstream = yield* TokenUpstream;

  // mint 那三个额外依赖。**这里是它们唯一一次与上游同处一个作用域** —— 再往下就交给
  // `makeMinting`,而它的 `MintDeps` 里一个上游都没有(`./mint` 的红线)。
  const globalRefIndex = yield* GlobalTokenRefIndexStore;
  const candidates = yield* CandidateSource;
  const namer = yield* Namer;

  // 每片只拿它真正要的端口 —— 这一行就是那张依赖表:`price` 的富化不碰上游、`catalogue` 不碰 store。
  return {
    ...makeMinting({ store, globalRefIndex, candidates, namer }),
    ...makeReading(store, prices),
    ...makePricing(store, prices, upstream),
    ...makeHistory(store, prices, upstream),
    ...makeStaleRefresh(store, prices, upstream),
    ...makeCatalogue(cache, upstream),
  } satisfies TokenServiceShape;
});

// `CandidateSource` 留在 `TokenService.Default` 的 `R` 上,由 `../oracle` 在装配时喂进来并
// **吃掉** —— 于是装配点的 `R` 里看不到它(它是包内 Tag,从不出包),而顶掉它仍然只需换一个
// layer,不必另开一条构造路(见 `./candidates` 里那段「注入缝」)。
export class TokenService extends Effect.Service<TokenService>()("oracle/TokenService", {
  effect: make,
}) {}
