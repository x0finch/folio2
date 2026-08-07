import { describe, expect, it } from "vitest";
import { HttpFailure, SigningFailure } from "../src/errors";
import { classifyFailure } from "../src/upstream-error";

// 默认归类规则。**所有 client 共用这一份** —— 上游特有的差异在各自包的出口 `catchTag` 里,
// 不在这个函数的参数上(见下面那条用例)。
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

  it("上游特有的差异**不在这里** —— 400 照默认规则归「够不到上游」", () => {
    // binance 要把 400 读成「签名请求被拒」,那一条由它自己在出口 `catchTag` 改判(它的测试钉住)。
    // 以前这里收一个 `override` 回调,和被删掉的 `toFailure` 同一个毛病:把流水线上的一步
    // 藏进配置对象里。归类函数只管**默认规则**,保持一个上游一份判断、看得见。
    expect(classify(http({ status: 400 }))._tag).toBe("UpstreamUnavailableError");
  });

  it("失败信息只带 pathname,不带 query(原则 #5 红线)", () => {
    // `HttpFailure.where` 就只是 pathname,这里钉的是归类过程没把别的东西塞进来。
    const err = classify(http({ where: "/v1/t", cause: new Error("boom") }));
    expect(err.where).toBe("/v1/t");
  });
});
