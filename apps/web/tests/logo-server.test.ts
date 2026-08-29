import { afterEach, describe, expect, it, vi } from "vitest";
import { serveLogo } from "@/lib/server/logos/serve";

// serveLogo 只收一个"解析上游 URL"的 thunk(cache-only)+ spy 全局 fetch。
// 断言状态/缓存头/透传/Cache-Tag,不测 Workers Cache 本身。kind/id 仅用于 Cache-Tag 命名。
const resolving = (logo?: string) => async (): Promise<string | undefined> => logo;
const img = () =>
  new Response(new Uint8Array([1, 2, 3]), {
    status: 200,
    headers: { "content-type": "image/png" },
  });

afterEach(() => vi.restoreAllMocks());

describe("serveLogo", () => {
  it("有上游图 → 200 + 透传 + 命中缓存头 + Cache-Tag + nosniff", async () => {
    const spy = vi.spyOn(globalThis, "fetch").mockResolvedValue(img());
    const res = await serveLogo(resolving("https://cgk/usdc.png"), "token", "usd-coin");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/png");
    expect(res.headers.get("cache-control")).toBe(
      "public, max-age=86400, stale-while-revalidate=2592000",
    );
    expect(res.headers.get("cache-tag")).toBe("logo:token:usd-coin");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(String(spy.mock.calls[0][0])).toBe("https://cgk/usdc.png");
  });

  it("platform kind → Cache-Tag 用 platform 命名空间", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(img());
    const res = await serveLogo(resolving("https://cgk/eth.png"), "platform", "bitcoin");
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-tag")).toBe("logo:platform:bitcoin");
  });

  it("上游非栅格图(svg/html)→ 降级 octet-stream + nosniff(挡本域内联执行)", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(new Uint8Array([1]), {
        status: 200,
        headers: { "content-type": "image/svg+xml" },
      }),
    );
    const res = await serveLogo(resolving("https://cgk/x.svg"), "token", "x");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/octet-stream");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
  });

  it("解析无 logo(cache miss/无图)→ 404 + 短负缓存,不打上游", async () => {
    const spy = vi.spyOn(globalThis, "fetch");
    const res = await serveLogo(resolving(undefined), "token", "unknown");
    expect(res.status).toBe(404);
    expect(res.headers.get("cache-control")).toBe("public, max-age=3600");
    expect(spy).not.toHaveBeenCalled();
  });

  it("上游 404 → 404 + 短负缓存", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 404 }));
    const res = await serveLogo(resolving("https://cgk/gone.png"), "token", "gone");
    expect(res.status).toBe(404);
    expect(res.headers.get("cache-control")).toBe("public, max-age=3600");
  });

  it("上游 5xx → 502 no-store(可重试)", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 503 }));
    const res = await serveLogo(resolving("https://cgk/x.png"), "token", "x");
    expect(res.status).toBe(502);
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  it("网络故障 → 502 no-store", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network"));
    const res = await serveLogo(resolving("https://cgk/x.png"), "token", "x");
    expect(res.status).toBe(502);
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  it("解析抛错 → 404 负缓存(容错)", async () => {
    const spy = vi.spyOn(globalThis, "fetch");
    const res = await serveLogo(
      async () => {
        throw new Error("store down");
      },
      "platform",
      "bitcoin",
    );
    expect(res.status).toBe(404);
    expect(spy).not.toHaveBeenCalled();
  });

  // data-URI 内嵌图(OKX 合成行品牌标 / 法币图):就地解码,不 fetch。走同一套安全过滤 + 缓存头。
  it("data: 栅格图 → 200 + 解码字节 + 命中缓存头 + nosniff,不打上游", async () => {
    const spy = vi.spyOn(globalThis, "fetch");
    // "AQID" = base64 of [1,2,3]
    const res = await serveLogo(resolving("data:image/png;base64,AQID"), "token", "okx-synth", {
      private: true,
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/png");
    expect(res.headers.get("cache-control")).toBe(
      "private, max-age=86400, stale-while-revalidate=2592000",
    );
    expect(res.headers.get("cache-tag")).toBe("logo:token:okx-synth");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3]));
    expect(spy).not.toHaveBeenCalled();
  });

  it("data: 非栅格图(svg+xml)→ 降级 octet-stream + nosniff(挡本域内联执行)", async () => {
    const res = await serveLogo(
      resolving("data:image/svg+xml;base64,PHN2Zy8+"), // "<svg/>"
      "token",
      "x",
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/octet-stream");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
  });

  it("data: 无 base64 标记(百分号转义)→ 解码文本字节", async () => {
    const res = await serveLogo(resolving("data:image/gif,%01%02"), "token", "y");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/gif");
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(new Uint8Array([1, 2]));
  });

  it("畸形 data-URI(无逗号)→ 404 负缓存", async () => {
    const res = await serveLogo(resolving("data:image/png;base64"), "token", "z");
    expect(res.status).toBe(404);
    expect(res.headers.get("cache-control")).toBe("public, max-age=3600");
  });

  it("data: base64 坏 payload → 404 负缓存(解码失败当没图)", async () => {
    const res = await serveLogo(resolving("data:image/png;base64,@@@@"), "token", "z");
    expect(res.status).toBe(404);
  });
});
