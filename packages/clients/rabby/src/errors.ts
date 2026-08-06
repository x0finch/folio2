import { classifyFailure } from "@folio/client-core";

// **错误类型在 `@folio/client-core`**(四类:凭据 / 限流 / 够不到 / 读不动)。
// Rabby **没有归类差异**,所以没有 `override`。
//
// 值得记一笔的是**签名失败**:它由 `SigningFailure` 走错误通道,再由 `classifyFailure` 归成
// 「凭据问题」——这是对的,因为它和「凭据被远端拒绝」在处理上同类:重试没有意义、要人介入
// (通常意味着上游改了签名协议,得重新 vendoring)。若错标成可重试,会退化成「退避全白打」
// 还把真正的原因盖掉。
export const classify = classifyFailure({ upstream: "rabby" });
