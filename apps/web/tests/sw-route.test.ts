import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
// 手搓 SW 的纯路由决策(唯一值钱的自动化缝,见 ADR 0027)。import 的是服务端静态资源 public/sw.js
// 本体 —— 它把 SW 事件挂载守在 `self.skipWaiting` 探测后,node 里只会执行到 export,不触发副作用。
import { swRoute } from "../public/sw.js";

// 更新检测靠「每次发版 sw.js 内容不同」,而这由构建期替换 `__SW_BUILD__` 占位实现(vite 的
// stampSwVersion)。占位一旦被误删,替换就没了着落 → sw.js 恒定 → 更新检测对普通发版永不触发。守住它。
it("public/sw.js 带 __SW_BUILD__ 版本占位(供构建期戳版本 → 触发更新检测)", () => {
  const src = readFileSync(new URL("../public/sw.js", import.meta.url), "utf-8");
  expect(src).toContain("__SW_BUILD__");
});

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

  it("/assets/ 下的 script / style / font(带内容哈希)→ cache-first", () => {
    expect(swRoute({ ...base, destination: "script", pathname: "/assets/app-abc12345.js" })).toBe(
      "cache-first",
    );
    expect(
      swRoute({ ...base, destination: "style", pathname: "/assets/styles-abc12345.css" }),
    ).toBe("cache-first");
    expect(
      swRoute({ ...base, destination: "font", pathname: "/assets/geist-abc12345.woff2" }),
    ).toBe("cache-first");
  });

  // 这条是回归测试:曾经只看 destination、不看路径,于是没哈希的 URL 被永久钉死 ——
  // 在跑过 preview 的域名上再跑 dev,SW 会一直发上一轮的 `/src/styles.css`(改样式不生效,
  // 私密标签页却正常)。没哈希 = 内容会变 = 不能 cache-first。
  it("不在 /assets/ 下的 script / style / font → network-only(URL 没哈希,内容会变)", () => {
    expect(swRoute({ ...base, destination: "style", pathname: "/src/styles.css" })).toBe(
      "network-only",
    );
    expect(swRoute({ ...base, destination: "script", pathname: "/src/client.tsx" })).toBe(
      "network-only",
    );
    expect(swRoute({ ...base, destination: "font", pathname: "/fonts/geist.woff2" })).toBe(
      "network-only",
    );
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
