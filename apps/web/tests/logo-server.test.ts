import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LOGO_EDGE_TTL_S, logoCacheKey } from "@/lib/server/logos/edge-cache";
import { serveLogo } from "@/lib/server/logos/serve";

const deferred = vi.hoisted(() => [] as Promise<unknown>[]);
vi.mock("cloudflare:workers", () => ({
  waitUntil: (p: Promise<unknown>) => {
    deferred.push(p);
  },
}));
const settle = () => Promise.all(deferred.splice(0));

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
  it("upstream image: 200 + passthrough + cache-hit headers + Cache-Tag + nosniff", async () => {
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

  it("platform kind: Cache-Tag uses the platform namespace", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(img());
    const res = await serveLogo(resolving("https://cgk/eth.png"), "platform", "bitcoin");
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-tag")).toBe("logo:platform:bitcoin");
  });

  it("upstream non-raster image (svg/html): downgraded to octet-stream + nosniff (blocks inline execution on our origin)", async () => {
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

  it("resolve yields no logo (cache miss / no image): 404 + short negative cache, upstream not hit", async () => {
    const spy = vi.spyOn(globalThis, "fetch");
    const res = await serveLogo(resolving(undefined), "token", "unknown");
    expect(res.status).toBe(404);
    expect(res.headers.get("cache-control")).toBe("public, max-age=3600");
    expect(spy).not.toHaveBeenCalled();
  });

  it("upstream 404: 404 + short negative cache", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 404 }));
    const res = await serveLogo(resolving("https://cgk/gone.png"), "token", "gone");
    expect(res.status).toBe(404);
    expect(res.headers.get("cache-control")).toBe("public, max-age=3600");
  });

  it("upstream 5xx: 502 no-store (retryable)", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 503 }));
    const res = await serveLogo(resolving("https://cgk/x.png"), "token", "x");
    expect(res.status).toBe(502);
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  it("network failure: 502 no-store", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network"));
    const res = await serveLogo(resolving("https://cgk/x.png"), "token", "x");
    expect(res.status).toBe(502);
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  it("resolve throws: 404 negative cache (tolerant)", async () => {
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

  it("data: raster image: 200 + decoded bytes + cache-hit headers + nosniff, upstream not hit", async () => {
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

  it("data: non-raster (svg+xml): downgraded to octet-stream + nosniff (blocks inline execution on our origin)", async () => {
    const res = await serveLogo(
      resolving("data:image/svg+xml;base64,PHN2Zy8+"), // "<svg/>"
      "token",
      "x",
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/octet-stream");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
  });

  it("data: without base64 marker (percent-escaped): decodes text bytes", async () => {
    const res = await serveLogo(resolving("data:image/gif,%01%02"), "token", "y");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/gif");
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(new Uint8Array([1, 2]));
  });

  it("data: without base64 and high bytes (invalid UTF-8 percent escapes): 404 fallback, no corrupt bytes emitted", async () => {
    const res = await serveLogo(resolving("data:image/png,%89PNG"), "token", "hi");
    expect(res.status).toBe(404);
  });

  it("malformed data-URI (no comma): 404 negative cache", async () => {
    const res = await serveLogo(resolving("data:image/png;base64"), "token", "z");
    expect(res.status).toBe(404);
    expect(res.headers.get("cache-control")).toBe("public, max-age=3600");
  });

  it("data: bad base64 payload: 404 negative cache (decode failure treated as no image)", async () => {
    const res = await serveLogo(resolving("data:image/png;base64,@@@@"), "token", "z");
    expect(res.status).toBe(404);
  });
});

describe("serveLogo edge cache (keyed by upstream URL)", () => {
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
        store.set(req.url, new Response(await res.arrayBuffer(), { headers: res.headers }));
      },
    };
    vi.stubGlobal("caches", { open: async () => cache });
  });

  it("second request for the same image: edge hit, upstream not hit; bytes and headers correct", async () => {
    const spy = vi.spyOn(globalThis, "fetch").mockImplementation(async () => img());
    const first = await serveLogo(resolving("https://cgk/usdc.png"), "token", "a", {
      private: true,
    });
    expect(new Uint8Array(await first.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3]));
    expect(first.headers.get("x-folio-logo-cache")).toBe("miss");
    await settle();

    const second = await serveLogo(resolving("https://cgk/usdc.png"), "token", "b", {
      private: true,
    });
    expect(spy).toHaveBeenCalledTimes(1);
    expect(second.status).toBe(200);
    expect(new Uint8Array(await second.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3]));
    expect(second.headers.get("content-type")).toBe("image/png");
    expect(second.headers.get("x-content-type-options")).toBe("nosniff");
    expect(second.headers.get("cache-control")).toBe(
      "private, max-age=86400, stale-while-revalidate=2592000",
    );
    expect(second.headers.get("cache-tag")).toBe("logo:token:b");
    expect(second.headers.get("x-folio-logo-cache")).toBe("hit");
  });

  it("cache key derives only from the upstream URL: no userId / Cookie / session, key request carries no headers", async () => {
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
    expect(Object.fromEntries(putValues[0].headers)).toEqual({
      "content-type": "image/png",
      "cache-control": `public, max-age=${LOGO_EDGE_TTL_S}`,
    });
  });

  it("miss: goes to origin, streams 200 to the client as usual, and writes back to the cache", async () => {
    const spy = vi.spyOn(globalThis, "fetch").mockImplementation(async () => img());
    const res = await serveLogo(resolving("https://cgk/eth.png"), "platform", "evm:1");
    expect(res.status).toBe(200);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3]));
    await settle();
    expect(store.has(logoCacheKey("https://cgk/eth.png").url)).toBe(true);
  });

  it("upstream 404 / 5xx / network failure: not cached, next request goes to origin again", async () => {
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

  it("upstream 200 but not a raster image (svg): still downgraded and passed through, but not cached", async () => {
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

  it("cache read/write throws: does not block, degrades to origin fetch", async () => {
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
