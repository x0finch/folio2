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

  it("扩展公钥:派生首地址探端点,200 → true", async () => {
    const ZPUB84 =
      "zpub6rFR7y4Q2AijBEqTUquhVz398htDFrtymD9xYYfG1m4wAcvPhXNfE3EfH1r1ADqtfSdVCToUG868RvUUkgDKf31mGDtKsAYz2oz2AGutZYs";
    const spy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response(JSON.stringify({ address: "x" }), { status: 200 }));
    expect(await bitcoinProvider.validate(ctx({ identifier: ZPUB84 }))).toBe(true);
    // 派生的首地址(BIP84 native)进了请求 URL
    expect(String(spy.mock.calls[0][0])).toContain("bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu");
  });

  it("非法扩展公钥(乱串)→ false,派生即失败", async () => {
    expect(await bitcoinProvider.validate(ctx({ identifier: "zpubGARBAGE" }))).toBe(false);
  });
});
