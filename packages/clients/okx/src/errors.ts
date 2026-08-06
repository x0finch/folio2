import {
  UpstreamAuthError,
  type UpstreamError,
  UpstreamParseError,
  UpstreamUnavailableError,
} from "@folio/client-core";
import { AUTH_ERROR_CODES, CODE_OK } from "./constants";
import type { OkxEnvelope } from "./types";

export const UPSTREAM = "okx";

// **业务层错误:HTTP 200 + code ≠ "0"。** 与 Bybit 同一个坑,只是 OKX 的 code 是**字符串**。
// 归类它属于「读懂上游怎么说话」,归 client:适配层不该知道 50113 是签名错、50105 是 passphrase 错。
//
// 不查它的话,一个 200 + code 50113 会被当成功、`data` 为空,最后表现成「这个账户余额是 0」——
// 静默丢数据。
// **由 client 那唯一一个 `get()` 在 `Effect.flatMap` 里调**(以前是 core 的 `checkBody` 配置回调)。
// 六个端点都经过那个 `get()`,所以「漏掉一个端点」这条风险仍然不存在,而这一步现在是
// 看得见的代码,不是藏在配置对象里的回调。
export function codeError(body: unknown, where: string): UpstreamError | undefined {
  // **先确认它是个对象。** 上游回一个裸 `null`(合法的 200 JSON)时,直接读 `.code` 会抛
  // TypeError —— 那是 defect,不进错误通道,排查起来毫无线索。读不懂的形状就是 parse 失败。
  if (typeof body !== "object" || body === null) {
    return new UpstreamParseError({
      upstream: UPSTREAM,
      where,
      cause: "okx: response was not an object",
    });
  }
  const envelope = body as OkxEnvelope;
  if (envelope.code === CODE_OK) return undefined;
  const code = envelope.code ?? "?";
  // **业务码不填进 `status`** —— 那是 HTTP 状态码,混进来读日志的人分不清两者。
  const cause = `okx code ${code}: ${envelope.msg || "unknown"}`;
  return AUTH_ERROR_CODES.has(code)
    ? new UpstreamAuthError({ upstream: UPSTREAM, where, cause })
    : new UpstreamUnavailableError({ upstream: UPSTREAM, where, cause });
}
