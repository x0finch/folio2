// Hyperliquid API 常量(不硬编码散落,见原则 #8)。
//
// **只有请求层要的那些在这里。** 老 provider 包的 constants.ts 里还有 `EVM_ADDRESS_RE` ——
// 那是 `accountCreds` 的校验规则,属于适配层,不进 client(ADR 0036)。

export const HYPERLIQUID_API_BASE = "https://api.hyperliquid.xyz";
// 所有只读查询走同一个 info 端点(POST + JSON body 指定 type)。
export const INFO_PATH = "/info";
// 永续账户状态(保证金汇总 + 仓位),body: { type, user }。
export const CLEARINGHOUSE_TYPE = "clearinghouseState";

// —— 为什么这里**没有**速率闸 ——
// 判据是「有没有多个调用挤同一份额度」,不是「这个上游会不会限流」。
// hyperliquid 的 REST 额度按出口 IP 算:**1200 权重/分钟**,而 `clearinghouseState` 这类 info 请求
// 权重 2 → 约 600 次/分钟。我们一个账户只发 1 发,sync 最多并发 6 → 峰值 6 发。
// 装个闸永远不会拦到任何东西(桶永远是满的),那是装饰而不是保护,所以刻意不装。
// 出处:https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/rate-limits-and-user-limits
//       (REST 聚合 1200 权重/分钟;l2Book / allMids / clearinghouseState 等权重 2)
// 哪天这里开始按币种或按仓位逐个问,就该回来重算这笔账。
