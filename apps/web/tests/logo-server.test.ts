import type { CgkCoinId, EnrichedAsset, Tokens } from "@folio/tokens";
import { afterEach, describe, expect, it, vi } from "vitest";
import { serveLogo } from "../src/lib/server/logo";

// 注入假 tokens(只需 enrich)+ spy 全局 fetch。断言 serveLogo 的状态/缓存头/透传,不测 Workers Cache 本身。
const tokensWith = (logo?: string): Pick<Tokens, "enrich"> => ({
  enrich: async (): Promise<EnrichedAsset[]> => [
    { ref: { source: "coingecko", identifier: "usd-coin" as CgkCoinId }, logo },
  ],
});
const img = () =>
  new Response(new Uint8Array([1, 2, 3]), {
    status: 200,
    headers: { "content-type": "image/png" },
  });

afterEach(() => vi.restoreAllMocks());

describe("serveLogo (token)", () => {
  it("有上游图 → 200 + 透传 + 命中缓存头 + Cache-Tag", async () => {
    const spy = vi.spyOn(globalThis, "fetch").mockResolvedValue(img());
    const res = await serveLogo(tokensWith("https://cgk/usdc.png"), "token", "usd-coin");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/png");
    expect(res.headers.get("cache-control")).toBe(
      "public, max-age=86400, stale-while-revalidate=2592000",
    );
    expect(res.headers.get("cache-tag")).toBe("logo:token:usd-coin");
    expect(String(spy.mock.calls[0][0])).toBe("https://cgk/usdc.png");
  });

  it("enrich 无 logo(cache miss/无图)→ 404 + 短负缓存,不打上游", async () => {
    const spy = vi.spyOn(globalThis, "fetch");
    const res = await serveLogo(tokensWith(undefined), "token", "unknown");
    expect(res.status).toBe(404);
    expect(res.headers.get("cache-control")).toBe("public, max-age=3600");
    expect(spy).not.toHaveBeenCalled();
  });

  it("上游 404 → 404 + 短负缓存", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 404 }));
    const res = await serveLogo(tokensWith("https://cgk/gone.png"), "token", "gone");
    expect(res.status).toBe(404);
    expect(res.headers.get("cache-control")).toBe("public, max-age=3600");
  });

  it("上游 5xx → 502 no-store(可重试)", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 503 }));
    const res = await serveLogo(tokensWith("https://cgk/x.png"), "token", "x");
    expect(res.status).toBe(502);
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  it("网络故障 → 502 no-store", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network"));
    const res = await serveLogo(tokensWith("https://cgk/x.png"), "token", "x");
    expect(res.status).toBe(502);
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  it("非 token kind → 404(platform 见 #20)", async () => {
    const res = await serveLogo(tokensWith("https://cgk/x.png"), "platform", "chain:bitcoin");
    expect(res.status).toBe(404);
  });
});
