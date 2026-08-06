import { describe, expect, it } from "vitest";
import { HttpFailure, SigningFailure } from "../src/errors";
import { classifyFailure, UpstreamAuthError } from "../src/upstream-error";

// 默认归类规则。**所有 client 共用这一份** —— 每家上游只写自己跟它不一样的那点(`override`)。
const classify = classifyFailure({ upstream: "acme" });

const http = (fields: Partial<ConstructorParameters<typeof HttpFailure>[0]> = {}) =>
  new HttpFailure({ kind: "upstream", where: "/v1/t", ...fields });

describe("classifyFailure", () => {
  it("五种传输归类各自落到该落的那一类", () => {
    expect(classify(http({ kind: "auth", status: 401 }))._tag).toBe("UpstreamAuthError");
    expect(classify(http({ kind: "rate-limited", status: 429 }))._tag).toBe(
      "UpstreamRateLimitError",
    );
    expect(classify(http({ kind: "parse" }))._tag).toBe("UpstreamParseError");
    // 压根没出去 与 其余非 2xx 合成一类 —— 对消费者是同一件事:够不到上游。
    expect(classify(http({ kind: "network" }))._tag).toBe("UpstreamUnavailableError");
    expect(classify(http({ kind: "upstream", status: 503 }))._tag).toBe("UpstreamUnavailableError");
  });

  it("签不出来 → 凭据问题,不是传输故障", () => {
    // 归到网络类会让它吃满退避全白打,还把真正的原因盖掉(rabby 的 wasm 签名靠这条)。
    const err = classify(new SigningFailure({ where: "/v1/t", cause: "bad secret" }));
    expect(err._tag).toBe("UpstreamAuthError");
  });

  it("上游给的 Retry-After 带到错误上", () => {
    const err = classify(http({ kind: "rate-limited", status: 429, retryAfterMs: 7000 }));
    expect(err._tag === "UpstreamRateLimitError" && err.retryAfterMs).toBe(7000);
  });

  it("每个错误都带 upstream —— 类型合并之后「是谁失败的」只能靠数据带", () => {
    expect(classify(http()).upstream).toBe("acme");
    expect(classify(new SigningFailure({ where: "/v1/t" })).upstream).toBe("acme");
  });

  it("override 先于默认规则跑,返回 undefined 就走默认", () => {
    // binance 就是这么把「400 = 签名请求被拒」表达出来的 —— 一条,不是一整套错误类型。
    const withOverride = classifyFailure({
      upstream: "acme",
      override: (f) =>
        f.status === 400 ? new UpstreamAuthError({ upstream: "acme", where: f.where }) : undefined,
    });
    expect(withOverride(http({ status: 400 }))._tag).toBe("UpstreamAuthError");
    // 没命中 override 的照默认走。
    expect(withOverride(http({ status: 503 }))._tag).toBe("UpstreamUnavailableError");
  });

  it("失败信息只带 pathname,不带 query(原则 #5 红线)", () => {
    // `HttpFailure.where` 就只是 pathname,这里钉的是归类过程没把别的东西塞进来。
    const err = classify(http({ where: "/v1/t", cause: new Error("boom") }));
    expect(err.where).toBe("/v1/t");
  });
});
