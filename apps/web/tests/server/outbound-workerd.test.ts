import { FolioHttpClient, makeRequester } from "@folio/client-core";
import { Effect } from "effect";
import { describe, expect, it, vi } from "vitest";

// 【在真的 workerd 里发一发】—— 这个文件只钉一件事:**换成 `@effect/platform` 的 `HttpClient`
// 之后,出网在 Cloudflare 的运行时里真的还能出去。**
//
// 为什么值得单开一个:CODING.md 记着一条本仓踩过的坑 —— 「把 `fetch` 存进变量再调会丢 `this`,
// 在 CF Workers 上抛 `Illegal invocation`」。而 `FetchHttpClient` 内部正是
// `const fetch = ... ?? globalThis.fetch;` 然后 `fetch(url, …)` —— **不带 bind**。
// 那条坑记的是「当成另一个对象的方法调」(`this` 变成那个对象)。裸函数调(`this === undefined`)
// **实测 workerd 放行** —— 两种调法给的都是同一个 `Invalid URL`,没有 `Illegal invocation`。
// (这条没做成常驻断言:workerd 的 fetch 收到非法 URL 时会自己冒一条 unhandled rejection 出来,
//  怎么接都拦不住,会把整轮测试判失败。结论记在 CODING.md,证据就是上面这句。)
//
// 别的测试都在 node 环境里跑(假 `HttpClient` 或假 `globalThis.fetch`),没有一个会碰到这件事。
// 所以这里刻意**不打桩 `HttpClient`**,走真的 `FolioHttpClient`,只把 `globalThis.fetch` 换掉 ——
// 换掉的是「请求最终去哪」,而「怎么调用它」仍然是官方那套,在真 workerd 里跑一遍。
describe("出网在 workerd 里", () => {
  it("`FolioHttpClient` 发得出去 —— 不带 bind 调 fetch 不会 Illegal invocation", async () => {
    const seen: { url?: string; hadThis?: boolean } = {};
    vi.spyOn(globalThis, "fetch").mockImplementation(function (this: unknown, input) {
      seen.url = String(input);
      seen.hadThis = this !== undefined;
      return Promise.resolve(
        new Response(JSON.stringify({ ok: 1 }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      );
    } as typeof globalThis.fetch);

    const request = makeRequester({ baseUrl: "https://up.example.com", upstream: "probe" });

    const out = await Effect.runPromise(
      request<{ ok: number }>("/v1/thing").pipe(Effect.provide(FolioHttpClient)),
    );

    expect(out).toEqual({ ok: 1 });
    expect(seen.url).toBe("https://up.example.com/v1/thing");
    vi.restoreAllMocks();
  });

  it("上游 5xx 在这里也归成「够不到上游」,不是变成一个 defect", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("", { status: 503 }));
    const request = makeRequester({ baseUrl: "https://up.example.com", upstream: "probe" });

    const err = await Effect.runPromise(
      Effect.flip(request("/v1/thing").pipe(Effect.provide(FolioHttpClient))),
    );

    expect(err._tag).toBe("UpstreamUnavailableError");
    expect(err.where).toBe("/v1/thing"); // 只有 pathname(原则 #5 红线)
    vi.restoreAllMocks();
  });
});
