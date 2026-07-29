import { describe, expect, it } from "vitest";
import { withDefaultNoStore } from "../src/lib/server/internal/cache-headers";

// 回归护栏:生产上账号 B 看到了账号 A 的页面,根因是 CF 边缘按 URL(不含 Cookie)缓存了
// 不带 cache-control 的 SSR 响应。这些断言钉住「默认不可缓存,可缓存必须显式声明」。
describe("withDefaultNoStore", () => {
  it("给没声明 cache-control 的响应补上 private, no-store", () => {
    const out = withDefaultNoStore(new Response("<html>净值 $991,602.80</html>"));

    expect(out.headers.get("cache-control")).toBe("private, no-store");
  });

  it("同时补 Vary: Cookie —— 中间层若忽略 no-store,至少缓存键按会话分开", () => {
    const out = withDefaultNoStore(new Response("x"));

    expect(out.headers.get("vary")?.toLowerCase()).toContain("cookie");
  });

  it("不覆盖已显式声明的 cache-control(logo 代理要的边缘缓存不能被废掉)", () => {
    const logo = new Response(null, {
      status: 200,
      headers: { "cache-control": "public, max-age=86400, stale-while-revalidate=2592000" },
    });

    const out = withDefaultNoStore(logo);

    expect(out.headers.get("cache-control")).toBe(
      "public, max-age=86400, stale-while-revalidate=2592000",
    );
    expect(out).toBe(logo); // 原样放行,连克隆都不做
  });

  it("静态资产自带的 must-revalidate 同样不动", () => {
    const asset = new Response("console.log(1)", {
      headers: { "cache-control": "public, max-age=0, must-revalidate" },
    });

    expect(withDefaultNoStore(asset).headers.get("cache-control")).toBe(
      "public, max-age=0, must-revalidate",
    );
  });

  it("保留 status / statusText / 其余响应头 / body", async () => {
    const res = new Response("payload", {
      status: 418,
      statusText: "I'm a teapot",
      headers: { "content-type": "text/plain", "x-custom": "kept" },
    });

    const out = withDefaultNoStore(res);

    expect(out.status).toBe(418);
    expect(out.statusText).toBe("I'm a teapot");
    expect(out.headers.get("content-type")).toBe("text/plain");
    expect(out.headers.get("x-custom")).toBe("kept");
    await expect(out.text()).resolves.toBe("payload");
  });

  it("已有 Vary 时追加而不覆盖,且不重复 cookie", () => {
    const withEncoding = withDefaultNoStore(
      new Response("x", { headers: { vary: "accept-encoding" } }),
    );
    const vary = withEncoding.headers.get("vary")?.toLowerCase() ?? "";
    expect(vary).toContain("accept-encoding");
    expect(vary).toContain("cookie");

    const alreadyCookie = withDefaultNoStore(new Response("x", { headers: { vary: "Cookie" } }));
    expect(alreadyCookie.headers.get("vary")?.toLowerCase().split(",").length).toBe(1);
  });

  it("null-body status(204/304)不炸", () => {
    expect(withDefaultNoStore(new Response(null, { status: 204 })).status).toBe(204);
    expect(withDefaultNoStore(new Response(null, { status: 304 })).status).toBe(304);
  });

  it("重定向也不可缓存 —— 未登录跳 /login 被缓存下来会把登录用户也弹走", () => {
    const redirect = new Response(null, { status: 307, headers: { location: "/login" } });

    const out = withDefaultNoStore(redirect);

    expect(out.status).toBe(307);
    expect(out.headers.get("location")).toBe("/login");
    expect(out.headers.get("cache-control")).toBe("private, no-store");
  });
});
