import type { UpstreamError } from "@folio/client-core";
import {
  ConnectorAuthError,
  type ConnectorError,
  ConnectorFailure,
  ConnectorRateLimitError,
  ConnectorUnavailableError,
} from "@folio/connectors-basic";
import { Effect, Match } from "effect";

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
