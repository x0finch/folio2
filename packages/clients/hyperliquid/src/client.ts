import { makeRequester, type Outbound, type UpstreamError } from "@folio/client-core";
import { Context, Effect, Layer } from "effect";
import { CLEARINGHOUSE_TYPE, HYPERLIQUID_API_BASE, INFO_PATH, UPSTREAM } from "./constants";
import { ClearinghouseState } from "./types";

export interface HyperliquidConfig {
  // 基址,**当不透明整串用**。不传就直连官方。
  //
  // **这家没有 #264 那个需求** —— 代理覆盖是给被按地区拒的交易所用的(binance / bybit / okx),
  // hyperliquid 老代码里是硬编码的。留这个口子是为了七个 client 形状一致(以及测试拿它做隔离),
  // 不是因为已经有人要用。真需要时它已经在了。
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
  ) => Effect.Effect<ClearinghouseState, UpstreamError, Outbound>;
}

export class HyperliquidClient extends Context.Tag("clients/Hyperliquid")<
  HyperliquidClient,
  HyperliquidClientApi
>() {
  static readonly layer = (config: HyperliquidConfig = {}): Layer.Layer<HyperliquidClient> =>
    Layer.sync(HyperliquidClient, () => make(config));
}

// **不是 Effect**,与 binance 不同 —— 那边要 `yield* makeRateLimit`(闸的构造要 `Scope`),
// 这边没有闸,构造就是纯的。别为了形状统一而假装需要 Scope。
export function make(config: HyperliquidConfig = {}): HyperliquidClientApi {
  const request = makeRequester({
    baseUrl: config.apiBase ?? HYPERLIQUID_API_BASE,
    upstream: UPSTREAM,
    // 固定的头也走 `headers` 而不是塞进每次调用的 `init` —— 它是这个上游的属性,不是某一发的属性。
    // `content-type` 必须是 application/json,少了它 hyperliquid 回 422。
    headers: () =>
      Effect.succeed({ "content-type": "application/json", accept: "application/json" }),
  });

  return {
    clearinghouseState: (address) =>
      request(INFO_PATH, ClearinghouseState, {
        method: "POST",
        body: JSON.stringify({ type: CLEARINGHOUSE_TYPE, user: address }),
      }),
  };
}
