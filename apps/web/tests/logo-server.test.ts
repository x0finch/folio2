import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LOGO_EDGE_TTL_S, logoCacheKey } from "@/lib/server/logos/edge-cache";
import { serveLogo } from "@/lib/server/logos/serve";

// `waitUntil` 来自 workerd 的虚拟模块,node 里没有 —— 收下交给它的 promise,用例里再 await 掉
// (等价于「这次调用结束前写缓存那半跑完了」)。
const deferred = vi.hoisted(() => [] as Promise<unknown>[]);
vi.mock("cloudflare:workers", () => ({
  waitUntil: (p: Promise<unknown>) => {
    deferred.push(p);
  },
}));
const settle = () => Promise.all(deferred.splice(0));

// serveLogo 只收一个"解析上游 URL"的 thunk(cache-only)+ spy 全局 fetch。
// 断言状态/缓存头/透传/Cache-Tag,不测 Workers Cache 本身。kind/id 仅用于 Cache-Tag 命名。
const resolving = (logo?: string) => async (): Promise<string | undefined> => logo;
const img = () =>
  new Response(new Uint8Array([1, 2, 3]), {
    status: 200,
    headers: { "content-type": "image/png" },
  });

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  deferred.length = 0;
});

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

  it("data: 无 base64 的高位字节(非法 UTF-8 百分号)→ 404 fallback,不吐坏字节", async () => {
    // 非 base64 的二进制图在现实中不存在(图 data-URI 一律 base64)。真遇到 %89 这类非法 UTF-8
    // 百分号序列,decodeURIComponent 抛错 → 当没图返回 404(首字母 fallback,不是坏图)。
    const res = await serveLogo(resolving("data:image/png,%89PNG"), "token", "hi");
    expect(res.status).toBe(404);
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

// 上游字节的边缘缓存(FOL-93)。假 Cache API:按 key 的 URL 存一份,记下每次 put 的 key 请求本身。
describe("serveLogo 边缘缓存(按上游 URL)", () => {
  let store: Map<string, Response>;
  let putKeys: Request[];
  let putValues: Response[];

  beforeEach(() => {
    store = new Map();
    putKeys = [];
    putValues = [];
    const cache = {
      match: async (req: Request) => store.get(req.url)?.clone(),
      put: async (req: Request, res: Response) => {
        putKeys.push(req);
        putValues.push(res.clone());
        // 与真 Cache API 一样把 body 读完再存。
        store.set(req.url, new Response(await res.arrayBuffer(), { headers: res.headers }));
      },
    };
    vi.stubGlobal("caches", { open: async () => cache });
  });

  it("同一张图第二次请求 → 边缘命中,不再打上游;字节与头都对", async () => {
    const spy = vi.spyOn(globalThis, "fetch").mockImplementation(async () => img());
    const first = await serveLogo(resolving("https://cgk/usdc.png"), "token", "a", {
      private: true,
    });
    expect(new Uint8Array(await first.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3]));
    await settle();

    const second = await serveLogo(resolving("https://cgk/usdc.png"), "token", "b", {
      private: true,
    });
    expect(spy).toHaveBeenCalledTimes(1);
    expect(second.status).toBe(200);
    expect(new Uint8Array(await second.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3]));
    expect(second.headers.get("content-type")).toBe("image/png");
    expect(second.headers.get("x-content-type-options")).toBe("nosniff");
    // 头按这次请求重建:private 照旧、Cache-Tag 是这次的 id,缓存副本的 public max-age 不外泄。
    expect(second.headers.get("cache-control")).toBe(
      "private, max-age=86400, stale-while-revalidate=2592000",
    );
    expect(second.headers.get("cache-tag")).toBe("logo:token:b");
  });

  it("缓存键只由上游 URL 派生:不含 userId / Cookie / 会话,键请求不带任何头", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => img());
    await serveLogo(resolving("https://cgk/usdc.png?size=large"), "token", "user-row-id-123", {
      private: true,
    });
    await settle();

    expect(putKeys).toHaveLength(1);
    const key = putKeys[0];
    expect(key.url).toBe(logoCacheKey("https://cgk/usdc.png?size=large").url);
    expect(key.url).not.toContain("user-row-id-123");
    expect([...key.headers.keys()]).toEqual([]);
    // 存进去的副本只有 content-type + 存多久,没有别的。
    expect(Object.fromEntries(putValues[0].headers)).toEqual({
      "content-type": "image/png",
      "cache-control": `public, max-age=${LOGO_EDGE_TTL_S}`,
    });
  });

  it("没命中 → 回源、照常 200 流给客户端,并写回缓存", async () => {
    const spy = vi.spyOn(globalThis, "fetch").mockImplementation(async () => img());
    const res = await serveLogo(resolving("https://cgk/eth.png"), "platform", "evm:1");
    expect(res.status).toBe(200);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3]));
    await settle();
    expect(store.has(logoCacheKey("https://cgk/eth.png").url)).toBe(true);
  });

  it("上游 404 / 5xx / 网络故障 → 不进缓存,下一次照样回源", async () => {
    const spy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response(null, { status: 404 }))
      .mockResolvedValueOnce(new Response(null, { status: 503 }))
      .mockRejectedValueOnce(new Error("network"))
      .mockImplementation(async () => img());
    for (const status of [404, 502, 502]) {
      const res = await serveLogo(resolving("https://cgk/x.png"), "token", "x");
      expect(res.status).toBe(status);
    }
    await settle();
    expect(putKeys).toHaveLength(0);

    const ok = await serveLogo(resolving("https://cgk/x.png"), "token", "x");
    expect(ok.status).toBe(200);
    expect(spy).toHaveBeenCalledTimes(4);
  });

  it("上游 200 但不是栅格图(svg)→ 照旧降级透传,但不进缓存", async () => {
    const svg = () =>
      new Response(new Uint8Array([1]), {
        status: 200,
        headers: { "content-type": "image/svg+xml" },
      });
    const spy = vi.spyOn(globalThis, "fetch").mockImplementation(async () => svg());
    const res = await serveLogo(resolving("https://cgk/x.svg"), "token", "x");
    expect(res.headers.get("content-type")).toBe("application/octet-stream");
    await settle();
    expect(putKeys).toHaveLength(0);
    await serveLogo(resolving("https://cgk/x.svg"), "token", "x");
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it("缓存读写抛错 → 不阻断,退化成回源", async () => {
    vi.stubGlobal("caches", {
      open: async () => {
        throw new Error("cache down");
      },
    });
    const spy = vi.spyOn(globalThis, "fetch").mockImplementation(async () => img());
    const res = await serveLogo(resolving("https://cgk/usdc.png"), "token", "a");
    expect(res.status).toBe(200);
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3]));
    await settle();
    expect(spy).toHaveBeenCalledTimes(1);
  });
});
