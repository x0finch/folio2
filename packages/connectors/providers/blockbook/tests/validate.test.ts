import type { ScriptType } from "@folio/bitcoin-derive";
import { afterEach, describe, expect, it, vi } from "vitest";
import { blockbookProvider } from "../src";

const ADDR = "1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa";
const ZPUB84 =
  "zpub6rFR7y4Q2AijBEqTUquhVz398htDFrtymD9xYYfG1m4wAcvPhXNfE3EfH1r1ADqtfSdVCToUG868RvUUkgDKf31mGDtKsAYz2oz2AGutZYs";

// 新 FetchContext 形状:account.creds(AC:identifier + scriptType)+ creds(PC:空)。
// CredsOf 把两字段都作必填键(scriptType 值可为 undefined),故显式带上 scriptType 键。
function ctx(input: { identifier: string; scriptType?: ScriptType }) {
  return {
    account: {
      id: "a1",
      label: "Cold",
      connectorId: "bitcoin",
      creds: { identifier: input.identifier, scriptType: input.scriptType },
    },
    creds: {},
  };
}

afterEach(() => vi.restoreAllMocks());

describe("blockbookProvider.validateAccount", () => {
  it("地址:打 /address/,200 → true", async () => {
    const spy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(
        new Response(JSON.stringify({ address: ADDR, balance: "0" }), { status: 200 }),
      );
    expect(await blockbookProvider.validateAccount(ctx({ identifier: ADDR }))).toBe(true);
    expect(String(spy.mock.calls[0][0])).toContain("/address/");
  });

  it("xpub:打 /xpub/(basic),200 → true", async () => {
    const spy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(
        new Response(JSON.stringify({ address: ZPUB84, balance: "0" }), { status: 200 }),
      );
    expect(await blockbookProvider.validateAccount(ctx({ identifier: ZPUB84 }))).toBe(true);
    expect(String(spy.mock.calls[0][0])).toContain("/xpub/");
  });

  it("端点全故障 → false", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("", { status: 500 }));
    expect(await blockbookProvider.validateAccount(ctx({ identifier: ADDR }))).toBe(false);
  });

  it("非法扩展公钥(乱串)→ false,造 token 即失败", async () => {
    expect(await blockbookProvider.validateAccount(ctx({ identifier: "zpubGARBAGE" }))).toBe(false);
  });
});
