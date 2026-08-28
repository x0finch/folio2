import { expect, test } from "@playwright/test";

// 登录后的页面弃 SSR、服务器只发骨架壳(ADR 0049 / FOL-34)。
//
// 为什么这几条非 e2e 不可:要钉的是**服务器发出去的那份 HTML 本身**——是不是 307、里面有没有
// 数据、有多大。这三样都在 HTTP 响应上,单测碰不到:路由的 `ssr` 选项由框架在真实请求里解析,
// mock 掉框架就等于把要验的东西替换掉了。
//
// 这条 spec 一律走 `request`(裸 HTTP)而不是 `page.goto`:浏览器会跟重定向、会执行 JS,
// 两样都会把「服务器原样回了什么」抹掉。

const AUTHED_PATHS = ["/", "/accounts", "/insights", "/settings"] as const;

test.describe("未登录:服务端就被带去登录页", () => {
  for (const path of AUTHED_PATHS) {
    test(`${path} → 307 /login`, async ({ request }) => {
      // 不带任何 cookie 的裸请求(fixture 里的 request 是全新 context,本来就没有会话)。
      const res = await request.get(path, { maxRedirects: 0 });
      expect(res.status()).toBe(307);
      expect(new URL(res.headers().location, "https://localhost").pathname).toBe("/login");
      // 服务端一个字节的页面都不该渲 —— 重定向是在 beforeLoad 里抛的,loader 还没跑。
      expect((await res.body()).byteLength).toBe(0);
    });
  }

  test("/login 自己不受影响,照常 200 出 HTML", async ({ request }) => {
    const res = await request.get("/login", { maxRedirects: 0 });
    expect(res.status()).toBe(200);
    expect(await res.text()).toContain("<!DOCTYPE html>");
  });
});
