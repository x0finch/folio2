// hyperliquid **适配层**的常量(原则 #8)。
//
// 端点路径、base URL、`clearinghouseState` 那个 body type —— 全归 `@folio/hyperliquid-client`,
// 那一半是「怎么跟上游说话」(ADR 0036)。这里只剩「怎么认这个账户」。
//
// 那家上游**没有速率闸**、以及为什么不装,理由写在 client 包里 —— 判据是「有没有多个调用挤
// 同一份额度」,而那是请求层的账。

// Hyperliquid 地址 = EVM 地址(0x + 40 hex)。
export const EVM_ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
