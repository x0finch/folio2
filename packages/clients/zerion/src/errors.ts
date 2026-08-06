import { classifyFailure } from "@folio/client-core";

// **错误类型在 `@folio/client-core`**(四类:凭据 / 限流 / 够不到 / 读不动)。
// Zerion **没有归类差异**,所以没有 `override` —— 它用标准 HTTP 语义,默认规则原样适用。
export const classify = classifyFailure({ upstream: "zerion" });
