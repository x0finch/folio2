import {
  classifyFailure,
  UpstreamAuthError,
  type UpstreamError,
  UpstreamUnavailableError,
} from "@folio/client-core";
import { AUTH_ERROR_CODES, RET_CODE_OK } from "./constants";
import type { BybitEnvelope } from "./types";

const UPSTREAM = "bybit";

// HTTP 层的归类。**Bybit 没有 HTTP 层的归类差异** —— 它的业务错误根本不走 HTTP 状态码
// (见下面的 retCode),所以这里就是默认规则。
export const classify = classifyFailure({ upstream: UPSTREAM });

// **业务层错误:HTTP 200 + retCode ≠ 0。** 这是 Bybit 最容易踩的一点 —— 请求「成功」了,
// 错误在 body 里。归类它属于「读懂上游怎么说话」,所以归 client,不归适配层:
// 适配层不该知道 10004 是签名错、33004 是 key 过期。
//
// 凭据/签名/权限类的 retCode → 凭据问题(重试没用);其余 → 上游的锅(重试有用)。
export function retCodeError(body: BybitEnvelope, where: string): UpstreamError | undefined {
  if (body.retCode === RET_CODE_OK) return undefined;
  const code = body.retCode ?? -1;
  // **retCode 不填进 `status`** —— 那个字段是 HTTP 状态码,混进业务码之后读日志的人分不清
  // 「503」和「10004」是同一类东西。它连同 retMsg 进 `cause`,自带前缀说明自己是什么。
  const cause = `bybit retCode ${code}: ${body.retMsg || "unknown"}`;
  return AUTH_ERROR_CODES.has(code)
    ? new UpstreamAuthError({ upstream: UPSTREAM, where, cause })
    : new UpstreamUnavailableError({ upstream: UPSTREAM, where, cause });
}
