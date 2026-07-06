import type { FetchContext } from "@folio/balances-basic";
import { afterEach, describe, expect, it, vi } from "vitest";
import { bitcoinProvider } from "../src";

const ADDR = "1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa";

function ctx(creds: FetchContext["creds"], globalKeys: Record<string, string> = {}): FetchContext {
  return {
    account: { id: "a1", userId: "u1", type: "onchain_bitcoin", label: "Cold" },
    creds,
    globalKeys,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("bitcoinProvider.validate", () => {
  it("打地址端点,200 → true", async () => {
    const spy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response(JSON.stringify({ address: ADDR }), { status: 200 }));
    expect(await bitcoinProvider.validate(ctx({ identifier: ADDR }))).toBe(true);
    expect(String(spy.mock.calls[0][0])).toContain(`/address/${ADDR}`);
  });

  it("非 2xx(如 400 无效地址)→ false", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("", { status: 400 }));
    expect(await bitcoinProvider.validate(ctx({ identifier: ADDR }))).toBe(false);
  });

  it("网络故障 → false", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network down"));
    expect(await bitcoinProvider.validate(ctx({ identifier: ADDR }))).toBe(false);
  });

  it("扩展公钥阶段 1 不支持 → false,不发请求", async () => {
    const spy = vi.spyOn(globalThis, "fetch");
    expect(await bitcoinProvider.validate(ctx({ identifier: "zpub6..." }))).toBe(false);
    expect(spy).not.toHaveBeenCalled();
  });
});
