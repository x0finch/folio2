import { Context } from "effect";
import type * as Upstreams from "./upstream";

// **出网那几个端口的 Tag**(Effect 的服务标识)。契约的类型在 `upstream.ts`,这里只把它们
// 提升成可 provide 的服务。
//
// **本地持久化那几片不在这里了。** 它们曾经也是端口(`TokenStore` / `TokenPriceStore` /
// `CacheStore` / `GlobalTokenRefIndexStore`),由本包定接口、`@folio/db` 顶上去实现。那层倒置
// 换不来第二个实现 —— 唯一的第二实现是本包测试里的内存假货,照形状写即可 —— 只换来两份
// 会各自漂移的 doc。现在契约就是 db 里那几份实现,取用走它的三张门票
// (`Database` / `DatabaseForOracle` / `GlobalDatabase`)。
//
// 剩下的这几个**是真端口**:出网这件事今天落在 CoinGecko 上,那是装配点的一行选择,
// 服务层不该知道(ADR 0023)—— 换一家就是换一个 layer。
//
// **为什么单开一个入口(`@folio/oracle-basic/ports`)而不是并进 index**:`Context.GenericTag(...)`
// 是**运行时值**,而本包的主入口被客户端组件 value-import(`SUPPORTED_CURRENCIES` /
// `tokenTicket` / `valuate`)。并进去就等于把 `effect` 挂在前端 bundle 的可达图上(+75 KB gzip),
// 能不能摇掉全看打包器 —— 而这条依赖本来就只有服务端需要。分入口是结构上的保证,不是指望摇树。
//
// **命名与 `@effect/platform` 同款**(`FileSystem` / `HttpClient` / `Path`):interface 与 Tag
// 同名同字,`yield* TokenUpstream` 拿到的就是 `TokenUpstream`。`packages/clients/*` 那边用的是
// `class XxxClient extends Context.Tag(...)<XxxClient, XxxClientApi>()` —— 那是「SDK 式出口」
// 的形状(一个包一个 client);端口这边契约名(`TokenUpstream`)本身就是全仓的词表,
// 不值得为了挂一个 `static layer` 把它们全改名成 `*Api`。

// 代币上游三面之交。**一个 Tag,不是三个** —— 三面恒由同一家实现(它们要共用同一份币目录
// 与同一套 id),分成三个 Tag 只会让装配点写三遍同一个 layer。
export type TokenUpstream = Upstreams.TokenUpstream;
export const TokenUpstream = Context.GenericTag<TokenUpstream>("oracle/TokenUpstream");

// 命名身份(id + 策展表)。**与 `TokenUpstream` 分开的 Tag** —— 写路径只要这个,不要网络面。
export type Namer = Upstreams.Namer;
export const Namer = Context.GenericTag<Namer>("oracle/Namer");

// 汇率与平台各自独立 —— 它们跟「这是哪个币」毫无关系,可以来自另一家(ADR 0023)。
export type FxUpstream = Upstreams.FxUpstream;
export const FxUpstream = Context.GenericTag<FxUpstream>("oracle/FxUpstream");

export type PlatformUpstream = Upstreams.PlatformUpstream;
export const PlatformUpstream = Context.GenericTag<PlatformUpstream>("oracle/PlatformUpstream");
