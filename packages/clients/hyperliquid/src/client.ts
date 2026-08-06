import {
  type HttpFailure,
  makeRequester,
  type SigningFailure,
  type UpstreamError,
} from "@folio/client-core";
import { Context, Effect, Layer } from "effect";
import { CLEARINGHOUSE_TYPE, HYPERLIQUID_API_BASE, INFO_PATH } from "./constants";
import { classify } from "./errors";
import type { ClearinghouseState } from "./types";

export interface HyperliquidConfig {
  // 基址,**当不透明整串用**(与 binance 同理:部署方可注入代理)。不传就直连官方。
  readonly apiBase?: string;
}

// Hyperliquid REST 的请求层。**方法按上游端点组织,吐的是上游形状(DTO)** ——
// `parseClearinghouseState` 那个纯函数、永续的计价模型、`tokenRef` 命名全留在适配层(ADR 0036)。
//
// 这个上游只有一个端点:`POST /info`,靠 body 里的 `type` 区分问什么。现在只问一件事
// (`clearinghouseState`),所以出口就一个方法 —— 将来要问别的(比如 spot 余额)再加一个,
// 而不是把 `type` 漏给调用方(那等于让调用方去拼 hyperliquid 的协议)。
//
// **没有闸**(见 constants.ts 那笔账),**不自带重试**(重试归 sync 那一层)。
export interface HyperliquidClientApi {
  // 永续账户状态:保证金汇总 + 各仓位。地址是 EVM 地址,每次调用传 —— 一个 client 服务多个账户。
  readonly clearinghouseState: (
    address: string,
  ) => Effect.Effect<ClearinghouseState, UpstreamError>;
}

export class HyperliquidClient extends Context.Tag("clients/Hyperliquid")<
  HyperliquidClient,
  HyperliquidClientApi
>() {
  static readonly layer = (config: HyperliquidConfig = {}): Layer.Layer<HyperliquidClient> =>
    Layer.succeed(HyperliquidClient, make(config));
}

// **不是 Effect**,与 binance 不同 —— 那边要 `yield* makeRateLimit`(闸的构造要 `Scope`),
// 这边没有闸,构造就是纯的。别为了形状统一而假装需要 Scope。
export function make(config: HyperliquidConfig = {}): HyperliquidClientApi {
  const request = makeRequester({
    baseUrl: config.apiBase ?? HYPERLIQUID_API_BASE,
    // 固定的头也走 `headers` 而不是塞进每次调用的 `init` —— 它是这个上游的属性,不是某一发的属性。
    // `content-type` 必须是 application/json,少了它 hyperliquid 回 422。
    headers: () =>
      Effect.succeed({ "content-type": "application/json", accept: "application/json" }),
  });

  return {
    clearinghouseState: (address) =>
      request<ClearinghouseState>(INFO_PATH, {
        init: {
          method: "POST",
          body: JSON.stringify({ type: CLEARINGHOUSE_TYPE, user: address }),
        },
      }).pipe(Effect.mapError((e: HttpFailure | SigningFailure) => classify(e))),
  };
}
