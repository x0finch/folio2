import { afterEach, describe, expect, it, vi } from "vitest";
import { createMempoolClient, MempoolError } from "../src";

const ADDR = "1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa";
const BODY = { address: ADDR, chain_stats: { funded_txo_sum: 100 }, mempool_stats: {} };

afterEach(() => vi.restoreAllMocks());

describe("createMempoolClient.getAddress", () => {
  it("默认打公共 mempool.space,带 UA,返回解析后的 AddressResponse", async () => {
    const spy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response(JSON.stringify(BODY), { status: 200 }));
    const res = await createMempoolClient().getAddress(ADDR);
    expect(res.chain_stats?.funded_txo_sum).toBe(100);
    expect(String(spy.mock.calls[0][0])).toBe(`https://mempool.space/api/address/${ADDR}`);
    expect((spy.mock.calls[0][1]?.headers as Record<string, string>)["user-agent"]).toBeTruthy();
  });

  it("baseUrl 覆写 → 走自托管;空串回退默认", async () => {
    // 每次返回新 Response(body 只能读一次)。
    const spy = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async () => new Response(JSON.stringify(BODY), { status: 200 }));
    await createMempoolClient({ baseUrl: "https://node.local/api" }).getAddress(ADDR);
    expect(String(spy.mock.calls[0][0])).toContain("https://node.local/api");
    await createMempoolClient({ baseUrl: "  " }).getAddress(ADDR);
    expect(String(spy.mock.calls[1][0])).toContain("https://mempool.space/api");
  });

  it("429 → RATE_LIMITED(retryable,读 Retry-After);401 → AUTH_FAILED;500 → UPSTREAM_ERROR", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("", { status: 429, headers: { "retry-after": "4" } }),
    );
    await expect(createMempoolClient().getAddress(ADDR)).rejects.toMatchObject({
      code: "RATE_LIMITED",
      retryable: true,
      retryAfterMs: 4000,
    });
    vi.restoreAllMocks();
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("", { status: 401 }));
    await expect(createMempoolClient().getAddress(ADDR)).rejects.toMatchObject({
      code: "AUTH_FAILED",
    });
    vi.restoreAllMocks();
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("", { status: 500 }));
    await expect(createMempoolClient().getAddress(ADDR)).rejects.toMatchObject({
      code: "UPSTREAM_ERROR",
    });
  });

  it("坏 JSON → PARSE_ERROR", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("not json", { status: 200 }));
    await expect(createMempoolClient().getAddress(ADDR)).rejects.toBeInstanceOf(MempoolError);
  });
});
