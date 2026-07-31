import type { ScriptType } from "@folio/bitcoin-derive";
import { ProviderError } from "@folio/connectors-basic";
import { afterEach, describe, expect, it, vi } from "vitest";
import { blockbookProvider } from "../src";

const ADDR = "1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa";
const ZPUB84 =
  "zpub6rFR7y4Q2AijBEqTUquhVz398htDFrtymD9xYYfG1m4wAcvPhXNfE3EfH1r1ADqtfSdVCToUG868RvUUkgDKf31mGDtKsAYz2oz2AGutZYs";

// 新 FetchContext 形状:account.creds(AC:addressOrXpub + scriptType)+ creds(PC:空)。
// CredsOf 把两字段都作必填键(scriptType 值可为 undefined),故显式带上 scriptType 键。
function ctx(input: { addressOrXpub: string; scriptType?: ScriptType }) {
  return {
    account: {
      id: "a1",
      label: "Cold",
      connectorId: "bitcoin",
      creds: { addressOrXpub: input.addressOrXpub, scriptType: input.scriptType },
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
    expect(await blockbookProvider.validateAccount(ctx({ addressOrXpub: ADDR }))).toBe(true);
    expect(String(spy.mock.calls[0][0])).toContain("/address/");
  });

  it("xpub:打 /xpub/(basic),200 → true", async () => {
    const spy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(
        new Response(JSON.stringify({ address: ZPUB84, balance: "0" }), { status: 200 }),
      );
    expect(await blockbookProvider.validateAccount(ctx({ addressOrXpub: ZPUB84 }))).toBe(true);
    expect(String(spy.mock.calls[0][0])).toContain("/xpub/");
  });

  // 契约(#240):够不到上游 → 抛 ProviderError(不压成 false),让调用方重试。
  it("端点全故障(5xx)→ 抛 UPSTREAM_ERROR(retryable)", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("", { status: 500 }));
    const err = await blockbookProvider
      .validateAccount(ctx({ addressOrXpub: ADDR }))
      .catch((e) => e);
    expect(err).toBeInstanceOf(ProviderError);
    expect(err.code).toBe("UPSTREAM_ERROR");
    expect(err.retryable).toBe(true);
  });

  it("429 → 抛 RATE_LIMITED(retryable)", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("", { status: 429 }));
    const err = await blockbookProvider
      .validateAccount(ctx({ addressOrXpub: ADDR }))
      .catch((e) => e);
    expect(err).toBeInstanceOf(ProviderError);
    expect(err.code).toBe("RATE_LIMITED");
  });

  // 服务端永久拒(4xx,如无效 xpub 的 400):客户端标 retryable:false,toProviderError 必须透传 ——
  // 否则被 ProviderError 按 code(UPSTREAM_ERROR)重算成 true,一个永久 400 被反复重试。
  it("服务端 400(永久)→ 抛 UPSTREAM_ERROR 且 retryable=false(不被重算)", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("", { status: 400 }));
    const err = await blockbookProvider
      .validateAccount(ctx({ addressOrXpub: ADDR }))
      .catch((e) => e);
    expect(err).toBeInstanceOf(ProviderError);
    expect(err.code).toBe("UPSTREAM_ERROR");
    expect(err.retryable).toBe(false);
  });

  // 凭据本身不成立:xpub 解析不出来 → INVALID_CREDENTIALS → false(等也没用,不该重试)。
  it("非法扩展公钥(乱串)→ false,造 token 即失败", async () => {
    expect(await blockbookProvider.validateAccount(ctx({ addressOrXpub: "zpubGARBAGE" }))).toBe(
      false,
    );
  });
});
