import {
  UpstreamAuthError,
  type UpstreamError,
  UpstreamParseError,
  UpstreamUnavailableError,
} from "@folio/client-core";
import { AUTH_ERROR_CODES, RET_CODE_OK } from "./constants";
import type { BybitEnvelope } from "./types";

export const UPSTREAM = "bybit";

// **业务层错误:HTTP 200 + retCode ≠ 0。** 这是 Bybit 最容易踩的一点 —— 请求「成功」了,
// 错误在 body 里。归类它属于「读懂上游怎么说话」,所以归 client,不归适配层:
// 适配层不该知道 10004 是签名错、33004 是 key 过期。
//
// 凭据/签名/权限类的 retCode → 凭据问题(重试没用);其余 → 上游的锅(重试有用)。
// 形状是 `HttpConfig.checkBody` 要的那个 —— 交给 requester,于是**每个端点自动都查**,
// 不必各写一个 `get()` 包装(那是漏掉一个端点的机会)。
export function retCodeError(body: unknown, where: string): UpstreamError | undefined {
  // **先确认它是个对象。** 上游回一个裸 `null`(合法的 200 JSON)时,直接读 `.retCode` 会抛
  // TypeError —— 那是 defect,不进错误通道,排查起来毫无线索。读不懂的形状就是 parse 失败。
  if (typeof body !== "object" || body === null) {
    return new UpstreamParseError({
      upstream: UPSTREAM,
      where,
      cause: "bybit: response was not an object",
    });
  }
  const envelope = body as BybitEnvelope;
  if (envelope.retCode === RET_CODE_OK) return undefined;
  const code = envelope.retCode ?? -1;
  // **retCode 不填进 `status`** —— 那个字段是 HTTP 状态码,混进业务码之后读日志的人分不清
  // 「503」和「10004」是同一类东西。它连同 retMsg 进 `cause`,自带前缀说明自己是什么。
  const cause = `bybit retCode ${code}: ${envelope.retMsg || "unknown"}`;
  return AUTH_ERROR_CODES.has(code)
    ? new UpstreamAuthError({ upstream: UPSTREAM, where, cause })
    : new UpstreamUnavailableError({ upstream: UPSTREAM, where, cause });
}
