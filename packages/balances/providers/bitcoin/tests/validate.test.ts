import type { FetchContext } from "@folio/balances-basic";
import { afterEach, describe, expect, it, vi } from "vitest";
import { bitcoinProvider } from "../src";

const ADDR = "1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa";
const ZPUB84 =
  "zpub6rFR7y4Q2AijBEqTUquhVz398htDFrtymD9xYYfG1m4wAcvPhXNfE3EfH1r1ADqtfSdVCToUG868RvUUkgDKf31mGDtKsAYz2oz2AGutZYs";

function ctx(creds: FetchContext["creds"]): FetchContext {
  return {
    account: { id: "a1", userId: "u1", type: "onchain_bitcoin", label: "Cold" },
    creds,
  };
}

afterEach(() => vi.restoreAllMocks());

describe("bitcoinProvider.validate", () => {
  it("地址:打 /address/,200 → true", async () => {
    const spy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(
        new Response(JSON.stringify({ address: ADDR, balance: "0" }), { status: 200 }),
      );
    expect(await bitcoinProvider.validateAccount(ctx({ identifier: ADDR }))).toBe(true);
    expect(String(spy.mock.calls[0][0])).toContain("/address/");
  });

  it("xpub:打 /xpub/(basic),200 → true", async () => {
    const spy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(
        new Response(JSON.stringify({ address: ZPUB84, balance: "0" }), { status: 200 }),
      );
    expect(await bitcoinProvider.validateAccount(ctx({ identifier: ZPUB84 }))).toBe(true);
    expect(String(spy.mock.calls[0][0])).toContain("/xpub/");
  });

  it("端点全故障 → false", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("", { status: 500 }));
    expect(await bitcoinProvider.validateAccount(ctx({ identifier: ADDR }))).toBe(false);
  });

  it("非法扩展公钥(乱串)→ false,造 token 即失败", async () => {
    expect(await bitcoinProvider.validateAccount(ctx({ identifier: "zpubGARBAGE" }))).toBe(false);
  });
});
