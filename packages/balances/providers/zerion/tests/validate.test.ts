import type { FetchContext } from "@folio/balances-basic";
import { afterEach, describe, expect, it, vi } from "vitest";
import { makeZerion } from "../src";

const ADDR = "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045";

function ctx(creds: FetchContext["creds"]): FetchContext {
  return {
    account: { id: "a1", userId: "u1", type: "onchain_evm", label: "Wallet" },
    creds,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("zerionProvider.validate", () => {
  // 地址格式由 validateCredentials 预校验;provider.validate 只对全局 key 缺失自查(不发请求)。
  it("returns false when the global key is missing, WITHOUT a request", async () => {
    const spy = vi.spyOn(globalThis, "fetch");
    expect(await makeZerion().validateAccount(ctx({ identifier: ADDR }))).toBe(false);
    expect(spy).not.toHaveBeenCalled();
  });

  it("hits the lightweight portfolio endpoint and returns true on 200", async () => {
    const spy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response(JSON.stringify({ data: {} }), { status: 200 }));
    expect(await makeZerion("k").validateAccount(ctx({ identifier: ADDR }))).toBe(true);
    expect(String(spy.mock.calls[0][0])).toContain(`/v1/wallets/${ADDR}/portfolio`);
  });

  it("returns false on 401/403", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("", { status: 401 }));
    expect(await makeZerion("k").validateAccount(ctx({ identifier: ADDR }))).toBe(false);
  });
});
