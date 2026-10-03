import { describe, expect, it } from "vitest";

// **认会话不许把 passkey 拉进来**(`session/session-auth.ts` 讲了为什么:约 12ms 的冷启动)。
//
// 这条约定破起来毫无声息 —— 谁在 server fn 的路径上随手 `import { getAuth } from ".../session/auth"`,
// 一切照常工作,只是每个冷请求又贵回去。所以从源码里数:
//   · 全量实例(`session/auth.ts`)只许被 `/api/auth` 那条路由**动态** `import()`;
//   · 服务端的 passkey 插件只许出现在全量实例里(`/client` 是浏览器那一半,不算)。

const sources = import.meta.glob("../src/**/*.{ts,tsx}", {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>;

const files = Object.entries(sources).map(([path, text]) => ({
  path: path.replace("../src/", ""),
  text,
}));

const FULL_AUTH = /["'](?:@\/lib\/server\/session|\.)\/auth["']/;
const STATIC_IMPORT = /^\s*import\s[^;]*?from\s*["'][^"']+["']/gm;

describe("认会话与全量 better-auth 分开加载", () => {
  it("全量实例只被 /api/auth 路由按需 import", () => {
    const importers = files.filter((f) => FULL_AUTH.test(f.text)).map((f) => f.path);
    expect(importers).toEqual(["routes/api/auth/$.ts"]);

    const route = files.find((f) => f.path === "routes/api/auth/$.ts")?.text ?? "";
    const staticOnes = (route.match(STATIC_IMPORT) ?? []).filter((s) => FULL_AUTH.test(s));
    expect(staticOnes).toEqual([]);
    expect(route).toMatch(/await import\(["']@\/lib\/server\/session\/auth["']\)/);
  });

  it("服务端 passkey 插件只在全量实例里", () => {
    const users = files
      .filter((f) => /from\s*["']@better-auth\/passkey["']/.test(f.text))
      .map((f) => f.path);
    expect(users).toEqual(["lib/server/session/auth.ts"]);
  });
});
