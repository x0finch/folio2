import { classifyFailure, UpstreamAuthError } from "@folio/client-core";
import { SIGNED_REQUEST_REJECTED_STATUS } from "./constants";

// **错误类型本身在 `@folio/client-core`**(四类:凭据 / 限流 / 够不到 / 读不动)。这里只写
// binance 跟默认归类**不一样**的那点差异 —— 一条。
//
// 为什么不各定一套:那四类的划分依据是「消费者要区分什么」,而消费者(适配层)对七个上游是同一个。
// 各定一套 = 7 套同构错误类 + 7 份重试策略 + 适配层 7 份几乎一样的映射。详见 core 那边的说明。
//
// 相对老 provider 的 `ProviderError` 仍是重新设计:老那版是一个类 + 六个 `code` 字符串 + 一个
// `retryable` 布尔,重试判据靠读那个布尔(鸭子类型,谁都能忘了传)。现在判据是 `_tag`,
// `catchTag` 有穷尽检查。

const UPSTREAM = "binance";

// **HTTP 400 → 凭据问题,不可重试。** binance 用 400 表达「这份签名请求被拒」,最常见的是错 secret
// (签名对不上,-1022)或 key 格式非法(-2014)。默认规则会把 400 归成「上游的锅」而去重试它 ——
// 重试没用,还会拿着错凭据再打一次上游,binance 会把重复认证失败当探测行为(#240)。
// 极少数非凭据 400(如 -1021 时钟偏移)也归此:同样非瞬时,且与迁移前行为一致。
export const classify = classifyFailure({
  upstream: UPSTREAM,
  override: (failure) =>
    failure.status === SIGNED_REQUEST_REJECTED_STATUS
      ? new UpstreamAuthError({
          upstream: UPSTREAM,
          where: failure.where,
          status: failure.status,
          cause: failure.cause,
        })
      : undefined,
});
