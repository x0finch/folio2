import {
  classifyFailure,
  UpstreamAuthError,
  type UpstreamError,
  UpstreamUnavailableError,
} from "@folio/client-core";
import { AUTH_ERROR_CODES, CODE_OK } from "./constants";
import type { OkxEnvelope } from "./types";

const UPSTREAM = "okx";

// HTTP 层的归类。**OKX 没有 HTTP 层的归类差异** —— 它的错误几乎都走 HTTP 200 + code(见下)。
export const classify = classifyFailure({ upstream: UPSTREAM });

// **业务层错误:HTTP 200 + code ≠ "0"。** 与 Bybit 同一个坑,只是 OKX 的 code 是**字符串**。
// 归类它属于「读懂上游怎么说话」,归 client:适配层不该知道 50113 是签名错、50105 是 passphrase 错。
//
// 不查它的话,一个 200 + code 50113 会被当成功、`data` 为空,最后表现成「这个账户余额是 0」——
// 静默丢数据。
export function codeError(body: OkxEnvelope, where: string): UpstreamError | undefined {
  if (body.code === CODE_OK) return undefined;
  const code = body.code ?? "?";
  // **业务码不填进 `status`** —— 那是 HTTP 状态码,混进来读日志的人分不清两者。
  const cause = `okx code ${code}: ${body.msg || "unknown"}`;
  return AUTH_ERROR_CODES.has(code)
    ? new UpstreamAuthError({ upstream: UPSTREAM, where, cause })
    : new UpstreamUnavailableError({ upstream: UPSTREAM, where, cause });
}
