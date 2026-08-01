import { describe, expect, it } from "vitest";
// 手搓 SW 的纯路由决策(唯一值钱的自动化缝,见 ADR 0027)。import 的是服务端静态资源 public/sw.js
// 本体 —— 它把 SW 事件挂载守在 `self.skipWaiting` 探测后,node 里只会执行到 export,不触发副作用。
import { swRoute } from "../public/sw.js";

const base = {
  method: "GET",
  mode: "cors",
  destination: "",
  sameOrigin: true,
  pathname: "/x",
};

describe("swRoute", () => {
  it("导航(文档)→ network-first", () => {
    expect(swRoute({ ...base, mode: "navigate" })).toBe("navigation");
  });

  it("/api/* → network-only(数据 / 鉴权,永不缓存)", () => {
    expect(swRoute({ ...base, pathname: "/api/auth/get-session" })).toBe("network-only");
    expect(swRoute({ ...base, pathname: "/api/accounts" })).toBe("network-only");
  });

  it("hashed script / style / font → cache-first", () => {
    expect(swRoute({ ...base, destination: "script", pathname: "/assets/app.abc123.js" })).toBe(
      "cache-first",
    );
    expect(swRoute({ ...base, destination: "style" })).toBe("cache-first");
    expect(swRoute({ ...base, destination: "font" })).toBe("cache-first");
  });

  it("非 GET(server fn / mutation)→ network-only", () => {
    // 即便目标像静态资源,只要是写请求就不缓存。
    expect(swRoute({ ...base, method: "POST", destination: "script" })).toBe("network-only");
  });

  it("跨源 → network-only(如 logo 代理目标)", () => {
    expect(swRoute({ ...base, destination: "image", sameOrigin: false })).toBe("network-only");
  });

  it("同源图片 / 其他 → network-only(保持新鲜,不做离线优先)", () => {
    expect(swRoute({ ...base, destination: "image", pathname: "/pwa-192.png" })).toBe(
      "network-only",
    );
    expect(swRoute({ ...base, pathname: "/manifest.json" })).toBe("network-only");
  });

  it("导航优先于路径判断", () => {
    expect(swRoute({ ...base, mode: "navigate", pathname: "/api/x" })).toBe("navigation");
  });
});
