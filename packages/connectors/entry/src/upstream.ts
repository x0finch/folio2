import type { UpstreamError } from "@folio/client-core";
import {
  ConnectorAuthError,
  type ConnectorError,
  ConnectorFailure,
  ConnectorRateLimitError,
  ConnectorUnavailableError,
  isRetryable,
} from "@folio/connectors-basic";
import { Effect, Either, Match } from "effect";

// 【请求层的错误 → connector 的错误】——**适配层唯一该做的错误翻译,写一次给九个上游用**。
//
// 为什么这个映射这么短:两边是**同一套划分**(见 `connectors-basic/connector-error.ts`)。
// `@folio/client-core` 的四类答「一个 HTTP 请求怎么失败的」,`ConnectorError` 的四类答
// 「取一个账户的余额怎么失败的」—— 划分依据都是「调用方要区分什么」,而那个调用方是同一个。
// 所以它是一对一,不是一张需要动脑子的对照表。**这本身就是那套划分对不对的证据**:
// 如果两边各按自己的上游特征分类,这里就会是一堆 if。
//
// 放 entry 不放 basic:basic 是契约层、被客户端代码引用,不该对 `@folio/client-core` 做值导入
// (它会把整个 HTTP 层拖进客户端 bundle)。翻译是**适配**,适配层就是它的家。
// **导出**给需要在翻译前看一眼 `status` 的适配层用(目前只有 bitcoin:它要把永久 4xx 判成
// 「重试改变不了」)。多数适配层用下面的 `asConnector` 就够。
export const fromUpstreamError: (error: UpstreamError) => ConnectorError =
  Match.type<UpstreamError>().pipe(
    Match.tag(
      "UpstreamAuthError",
      (e) => new ConnectorAuthError({ message: describe(e), cause: e }) as ConnectorError,
    ),
    Match.tag(
      "UpstreamRateLimitError",
      (e) =>
        new ConnectorRateLimitError({
          message: describe(e),
          retryAfterMs: e.retryAfterMs,
          cause: e,
        }) as ConnectorError,
    ),
    Match.tag(
      "UpstreamUnavailableError",
      (e) => new ConnectorUnavailableError({ message: describe(e), cause: e }) as ConnectorError,
    ),
    // 「上游变了形状」重试改变不了 —— 与 parse / unsupported / 没预料到的抛出同一类。
    Match.tag(
      "UpstreamParseError",
      (e) => new ConnectorFailure({ message: describe(e), cause: e }) as ConnectorError,
    ),
    // 上游将来加一种失败 → 这里当场编译红,逼着决定它归哪一类。
    Match.exhaustive,
  );

// 人能读的一行。**只用 `upstream` / `where` / `status`** —— `where` 按约定只有 pathname,
// 而 query 里有签名和地址(原则 #5 红线)。别往里加 `cause` 的字符串化:那是上游的原始响应,
// 里面什么都可能有。
const describe = (e: UpstreamError): string =>
  `${e.upstream} ${e._tag.replace("Upstream", "").replace("Error", "").toLowerCase()}` +
  ` at ${e.where}${e.status === undefined ? "" : ` (${e.status})`}`;

// 把一个用 client 的 effect 接到 connector 的错误面上。九个适配层都用这一句。
export const asConnector = <A, R>(
  effect: Effect.Effect<A, UpstreamError, R>,
): Effect.Effect<A, ConnectorError, R> => Effect.mapError(effect, fromUpstreamError);

// 【多桶尽力而为的成败裁定】——**写一次给三家 CEX 用**(binance / okx / bybit)。
//
// 它们都把一个账户拆成几个隔离的桶(钱包 / 账户类型)并发拉,于是都要回答同一个问题:
// 部分桶失败时,**这轮该交给重试,还是该降级写一份少了几块的快照。**
//
// 判据是失败的**种类**,不是数量(FOL-30 / FOL-31):
//
// · **「等一等会好」**(限流 / 超时 / 5xx)→ 整体失败,交给 sync 那层的退避重试;打光则不写快照,
//   旧值原样保住。降级是错的 —— 写出去的残缺快照会盖掉真实资产,而下一轮本来就能拉到。
//   生产上这正是资产每轮掉块的病灶。
// · **「等也没用」**(权限没勾 / 上游变了形状)→ 降级:写能拿到的那些 + 一条点名失败桶的 note。
//   重试变不出权限来,拦着不写等于这个账户永远存不进数据。
// · **全军覆没**是独立一条:哪怕全是「等也没用」(整把 key 被吊销)也失败 —— 降级写出去的会是
//   一份**空**快照,把账户的全部资产抹掉。
//
// 判据用契约的 `isRetryable`,和 sync 的重试策略是同一把尺子:这里判「该不该交给重试」,
// 那里判「还试不试」。两处各自照着 `_tag` 判,加一种错误时两边一起编译红。
//
// **只裁定,不碰数据**:成功桶的响应形状三家各不相同(有的直接是 rows,有的要按桶取原始响应
// 再解析),让它们各自处理;这里返回失败桶,供调用方拼各自的 note。
export const bestEffortVerdict = <
  T extends { readonly result: Either.Either<A, ConnectorError> },
  A,
>(
  outcomes: readonly T[],
): Either.Either<readonly T[], ConnectorError> => {
  const failed = outcomes.filter((o) => Either.isLeft(o.result));

  // 有「等一等会好」的 → 整体失败(混合时以瞬时那个为准:它才是重试的理由)。
  const transient = failed.find((o) => Either.isLeft(o.result) && isRetryable(o.result.left));
  if (transient && Either.isLeft(transient.result)) return Either.left(transient.result.left);

  // 全军覆没 → 也失败,别拿一份空快照覆盖已有余额。
  const first = failed[0];
  if (
    outcomes.length > 0 &&
    failed.length === outcomes.length &&
    first &&
    Either.isLeft(first.result)
  ) {
    return Either.left(first.result.left);
  }

  return Either.right(failed);
};
