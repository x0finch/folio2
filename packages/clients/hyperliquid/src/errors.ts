import { classifyFailure } from "@folio/client-core";

// **错误类型在 `@folio/client-core`**(四类:凭据 / 限流 / 够不到 / 读不动)。这里只写 hyperliquid
// 跟默认归类不一样的那点 —— **一条都没有**,所以没有 `override`。
//
// 为什么没有:info 端点**无 auth**(只读地址即查,没有 key、没有签名),所以「凭据被拒」这条路
// 在这个上游根本不存在;剩下的都是标准 HTTP 语义,默认规则原样适用。
//
// 老 provider 的 `toFailure` 也是这四条一一对应,没有特例 —— 那份代码有一半是在把
// `kind` 手写成 `ProviderError(code, message)`,现在由 core 统一做。
export const classify = classifyFailure({ upstream: "hyperliquid" });
