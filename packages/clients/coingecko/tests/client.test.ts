import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CoinGeckoError,
  createCoinGeckoClient,
  HEADER_DEMO,
  HEADER_PRO,
  parseRetryAfter,
  USER_AGENT,
} from "../src/index";

function mockFetch(res: Partial<Response> & { json?: () => Promise<unknown> }) {
  return vi.spyOn(globalThis, "fetch").mockResolvedValue(res as Response);
}
function ok(body: unknown): Partial<Response> {
  return { ok: true, status: 200, json: async () => body, headers: new Headers() };
}
async function grabErr(p: Promise<unknown>): Promise<CoinGeckoError> {
  try {
    await p;
    throw new Error("expected request to throw");
  } catch (e) {
    return e as CoinGeckoError;
  }
}
afterEach(() => vi.restoreAllMocks());

describe("createCoinGeckoClient · request", () => {
  it("注入 User-Agent 头(CF WAF 修复)", async () => {
    const f = mockFetch(ok({}));
    await createCoinGeckoClient().request("/ping");
    const init = f.mock.calls[0][1] as RequestInit;
    expect((init.headers as Record<string, string>)["user-agent"]).toBe(USER_AGENT);
  });

  it("demo key → demo 头 + free 基址", async () => {
    const f = mockFetch(ok({}));
    await createCoinGeckoClient({ apiKey: "k" }).request("/x");
    expect((f.mock.calls[0][0] as URL).toString()).toContain("api.coingecko.com/api/v3");
    expect((f.mock.calls[0][1] as RequestInit).headers).toMatchObject({ [HEADER_DEMO]: "k" });
  });

  it("pro key → pro 头 + pro 基址", async () => {
    const f = mockFetch(ok({}));
    await createCoinGeckoClient({ apiKey: "k", pro: true }).request("/x");
    expect((f.mock.calls[0][0] as URL).toString()).toContain("pro-api.coingecko.com");
    expect((f.mock.calls[0][1] as RequestInit).headers).toMatchObject({ [HEADER_PRO]: "k" });
  });

  it("拼 query 参数", async () => {
    const f = mockFetch(ok({}));
    await createCoinGeckoClient().request("/x", { a: 1, b: "z" });
    expect((f.mock.calls[0][0] as URL).search).toBe("?a=1&b=z");
  });

  it("429 → RATE_LIMITED,带 retryAfterMs", async () => {
    mockFetch({ ok: false, status: 429, headers: new Headers({ "retry-after": "30" }) });
    const err = await grabErr(createCoinGeckoClient().request("/x"));
    expect(err).toBeInstanceOf(CoinGeckoError);
    expect(err.code).toBe("RATE_LIMITED");
    expect(err.retryable).toBe(true);
    expect(err.retryAfterMs).toBe(30000);
  });

  it("404 + notFoundAsNull → null;否则 UPSTREAM_ERROR", async () => {
    mockFetch({ ok: false, status: 404, headers: new Headers() });
    expect(
      await createCoinGeckoClient().request("/x", undefined, { notFoundAsNull: true }),
    ).toBeNull();
    mockFetch({ ok: false, status: 404, headers: new Headers() });
    const err = await grabErr(createCoinGeckoClient().request("/x"));
    expect(err.code).toBe("UPSTREAM_ERROR");
  });

  it("5xx → UPSTREAM_ERROR retryable;网络异常 → 同", async () => {
    mockFetch({ ok: false, status: 502, headers: new Headers() });
    const a = await grabErr(createCoinGeckoClient().request("/x"));
    expect(a.code).toBe("UPSTREAM_ERROR");
    expect(a.retryable).toBe(true);
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("boom"));
    const b = await grabErr(createCoinGeckoClient().request("/x"));
    expect(b.code).toBe("UPSTREAM_ERROR");
    expect(b.retryable).toBe(true);
  });

  it("坏 JSON → PARSE_ERROR", async () => {
    mockFetch({
      ok: true,
      status: 200,
      headers: new Headers(),
      json: async () => {
        throw new Error("bad");
      },
    });
    const err = await grabErr(createCoinGeckoClient().request("/x"));
    expect(err.code).toBe("PARSE_ERROR");
  });
});

describe("parseRetryAfter", () => {
  it("纯秒数 → ms", () => expect(parseRetryAfter("30")).toBe(30000));
  it("HTTP-date → 相对 ms", () => {
    const at = Date.parse("Wed, 21 Oct 2026 07:28:00 GMT");
    expect(parseRetryAfter("Wed, 21 Oct 2026 07:28:00 GMT", at - 5000)).toBe(5000);
  });
  it("缺失/坏值 → undefined", () => {
    expect(parseRetryAfter(null)).toBeUndefined();
    expect(parseRetryAfter("not-a-date")).toBeUndefined();
  });
});
