// Hyperliquid API 常量(不硬编码散落进逻辑,见原则 #8)。
export const HYPERLIQUID_API_BASE = "https://api.hyperliquid.xyz";
// 所有只读查询走同一个 info 端点(POST + JSON body 指定 type)。
export const INFO_PATH = "/info";
// 永续账户状态(保证金汇总 + 仓位),body: { type, user }。
export const CLEARINGHOUSE_TYPE = "clearinghouseState";
// Hyperliquid 地址 = EVM 地址(0x + 40 hex)。本包自持,不跨 provider 依赖。
export const EVM_ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

// —— 为什么这里**没有**速率闸 ——
// 判据是「有没有多个调用挤同一份额度」,不是「这个 provider 会不会被限流」。
// hyperliquid 的 REST 额度按出口 IP 算:**1200 权重/分钟**,而 `clearinghouseState` 这类 info 请求
// 权重 2 → 约 600 次/分钟。我们一个账户只发 1 发,sync 最多并发 6 → 峰值 6 发。
// 装个闸永远不会拦到任何东西(桶永远是满的),那是装饰而不是保护,所以刻意不装。
// 出处:https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/rate-limits-and-user-limits
//       (REST 聚合 1200 权重/分钟;l2Book / allMids / clearinghouseState 等权重 2)
// 哪天这里开始按币种或按仓位逐个问,就该回来重算这笔账。
