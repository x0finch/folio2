import {
  makeRequester,
  type Outbound,
  type Requester,
  type UpstreamError,
  UpstreamUnavailableError,
} from "@folio/client-core";
import { Context, Effect, Layer, type Schema } from "effect";
import {
  BLOCKBOOK_BASES,
  DEFAULT_XPUB_DETAILS,
  DEFAULT_XPUB_TOKENS,
  UPSTREAM,
  USER_AGENT,
} from "./constants";
import { AddressResponse, XpubResponse } from "./types";

export interface BlockbookConfig {
  // 覆盖端点列表(测试 / 自托管节点);缺省用内置的 btc2–btc5。
  readonly bases?: readonly string[];
  readonly userAgent?: string;
}

export interface XpubQuery {
  readonly details?: "basic" | "tokens" | "tokenBalances";
  readonly tokens?: "nonzero" | "used" | "derived";
}

// Trezor Blockbook v2 的请求层(只读)。**方法按上游端点组织,吐的是上游形状(DTO)** ——
// satoshi 串转数字、UTXO 汇总、`tokenRef` 命名全在适配层(ADR 0036)。
//
// 这家上游没有凭据这回事(公共节点),所以方法不收 creds。
export interface BlockbookClientApi {
  // xpub / descriptor 的余额 + 逐地址(**服务端派生**,取代逐地址 gap 扫描)。
  readonly xpub: (
    token: string,
    query?: XpubQuery,
  ) => Effect.Effect<XpubResponse, UpstreamError, Outbound>;
  // 单地址余额。
  readonly address: (address: string) => Effect.Effect<AddressResponse, UpstreamError, Outbound>;
}

export class BlockbookClient extends Context.Tag("clients/Blockbook")<
  BlockbookClient,
  BlockbookClientApi
>() {
  static readonly layer = (config: BlockbookConfig = {}): Layer.Layer<BlockbookClient> =>
    Layer.sync(BlockbookClient, () => make(config));
}

// 轮询起点,**模块级** —— 分散负载,不让每一轮同步都从 btc2 开始。
// 刻意不在 `Scope` 里:CF Workers 上每个请求一次 `runPromise`,放 scope 就等于每次都从 0 开始
// (与时隙游标同一个理由)。
let cursor = 0;

// 「这个错误该不该换下一个节点」。
//
// **判据是 blockbook 自己的,不是通用的可重试性** —— 问的是「是这个节点不行,还是你的请求不行」:
//   · 被这个节点限流 / 够不到这个节点(网络、5xx)→ **换**,下一个节点大概率好使
//   · 无效的 xpub(4xx)→ **不换**,换四个节点得到同样的 4xx,白赔三次往返
//   · 凭据被拒、响应读不懂 → 不换,同理
//
// 所以不能直接拿「这个错误可不可重试」当判据:`UpstreamUnavailableError` 涵盖了网络失败、5xx
// **和** 4xx,而后者恰恰是不该换的那一类 —— 靠 `status` 分开。
const shouldTryNextBase = (error: UpstreamError): boolean => {
  if (error._tag === "UpstreamRateLimitError") return true;
  if (error._tag !== "UpstreamUnavailableError") return false;
  // 没有 status = 压根没出去(网络失败)→ 换。有 status 就只有 5xx 才换。
  return error.status === undefined || error.status >= 500;
};

export function make(config: BlockbookConfig = {}): BlockbookClientApi {
  const bases = config.bases?.length ? config.bases : BLOCKBOOK_BASES;
  const userAgent = config.userAgent ?? USER_AGENT;

  // 一个 base 一个 requester,**建一次**(`make` 每轮同步每账户调一次,不该每次重建四个)。
  const requesters: Requester[] = bases.map((baseUrl) =>
    makeRequester({
      baseUrl,
      upstream: UPSTREAM,
      // UA 必须发,见 constants.ts。
      headers: () => Effect.succeed({ "user-agent": userAgent, accept: "application/json" }),
    }),
  );

  // **依次试各个节点,直到成功或遇到「换了也没用」的错误。**
  //
  // 这就是 blockbook 的「重试」,而它是**换哪个节点**的策略,不是「一个请求怎么发」——
  // 所以留在这儿,不塞给 `Effect.retry`。两个都开的话每个节点先自己退避几次再换下一个,
  // 延迟直接乘起来。
  //
  // 用递归而不是 `Effect.firstSuccessOf`:后者对**任何**失败都继续试,而这里的要点恰恰是
  // 「有些错误要立刻停」(无效 xpub 换四个节点得到四个一样的 4xx)。
  const tryBases = <A, I>(
    path: string,
    schema: Schema.Schema<A, I>,
    query: Record<string, string> | undefined,
    from: number,
    left: number,
  ): Effect.Effect<A, UpstreamError, Outbound> =>
    Effect.suspend(() => {
      const at = requesters[from % requesters.length];
      return at(path, schema, { query }).pipe(
        Effect.catchAll((error) =>
          left > 1 && shouldTryNextBase(error)
            ? tryBases(path, schema, query, from + 1, left - 1)
            : Effect.fail(error),
        ),
      );
    });

  const request = <A, I>(
    path: string,
    schema: Schema.Schema<A, I>,
    query?: Record<string, string>,
  ): Effect.Effect<A, UpstreamError, Outbound> =>
    Effect.suspend(() => {
      if (requesters.length === 0) {
        return Effect.fail(
          new UpstreamUnavailableError({
            upstream: UPSTREAM,
            where: path,
            cause: "no blockbook endpoints configured",
          }),
        );
      }
      // 起点每次前进一格 —— 四个节点轮流当第一个。
      return tryBases(path, schema, query, cursor++, requesters.length);
    });

  // `encodeURIComponent` 不编码括号,但 descriptor(如 `tr(xpub…)`)的括号在 path 里更稳妥地编码掉。
  const encodePath = (s: string): string =>
    encodeURIComponent(s).replace(/\(/g, "%28").replace(/\)/g, "%29");

  // **`details` / `tokens` 走 query,不焊进 path 串** —— 那是 `makeRequester` 该拼的部分,
  // 自己拼就得自己管编码,而且失败信息里的 `where` 会连 query 一起带上(原则 #5)。
  //
  // ⚠️ **但 xpub 本身在 pathname 里**,所以它一定会进 `where` —— Blockbook 的 URL 形状就是
  // `/xpub/{token}`,躲不掉。xpub 在本仓的分类是 `public`(明文落库、可导出重建),不是 secret,
  // 所以这是可接受的;但它毕竟是**整个钱包的观察密钥**,别再往日志里多抄一份。
  return {
    xpub: (token, query) =>
      request(`/xpub/${encodePath(token)}`, XpubResponse, {
        details: query?.details ?? DEFAULT_XPUB_DETAILS,
        tokens: query?.tokens ?? DEFAULT_XPUB_TOKENS,
      }),

    address: (address) => request(`/address/${encodePath(address)}`, AddressResponse),
  };
}
