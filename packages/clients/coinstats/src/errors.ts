import { classifyFailure } from "@folio/client-core";

// **错误类型在 `@folio/client-core`**(四类:凭据 / 限流 / 够不到 / 读不动)。
// CoinStats **没有归类差异**,所以没有 `override` —— 它用标准 HTTP 语义:401/403 表示 key 不对,
// 429 表示超速,默认规则原样适用。
//
// 老 provider 的 `toFailure` 是五个 if 手写 `ProviderError(code, message)`,逐条对应这四类。
export const classify = classifyFailure({ upstream: "coinstats" });
