import { expect, test } from "@playwright/test";
import { dismissPasskeyPrompt, signUpAndLogin } from "./fixtures/app";

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

test.describe("登录后:服务器只发骨架壳", () => {
  test("那份 HTML 里只有骨架,没有任何数据", async ({ page }) => {
    const user = await signUpAndLogin(page);
    // `page.request` 共用浏览器上下文的 cookie,所以这是一次**带会话**的裸 HTTP 请求。
    const res = await page.request.get("/", { maxRedirects: 0 });
    expect(res.status()).toBe(200);
    const html = await res.text();

    expect(html).toContain('data-slot="skeleton"');

    // 侧栏那行用户名是 SSR 时**必然**出现的用户数据 —— 它不在,就说明 AppShell 根本没在服务端渲。
    // 这一条比「查有没有持仓数字」硬:它不依赖账号里有什么,新注册的空用户也照样能判。
    expect(html).not.toContain(user.name);
    expect(html).not.toContain(user.email);

    // 导航文案只有真外壳有(骨架里那四条是灰条)。逐个页面查:`ssr: false` 是**整树继承**的,
    // 漏一页的表现是那一页悄悄回到旧路子上,不会有任何报错。
    for (const path of AUTHED_PATHS) {
      const body = await (await page.request.get(path, { maxRedirects: 0 })).text();
      expect(body, `${path} 的服务端 HTML 不该带真外壳`).not.toContain(">Overview<");
      expect(body, `${path} 的服务端 HTML 该是骨架`).toContain('data-slot="skeleton"');
    }
  });

  test("浏览器接手后真外壳与数据浮现,期间不报水合错误", async ({ page }) => {
    // 水合报错是 recoverable error:React 抛、vite 客户端转发,`page.on("console")` 一条都收不到。
    // 必须听 `pageerror`(这条坑记在 no-hydration-mismatch.spec.ts 里,别再踩)。
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));

    await signUpAndLogin(page);
    await dismissPasskeyPrompt(page);
    errors.length = 0;

    await page.goto("/");
    // 骨架 → 真外壳:导航出现即证明客户端把 `_authed` 那棵树跑起来了。
    await expect(page.getByRole("link", { name: "Overview", exact: true })).toBeVisible();
    // 页头副标题只有 syncStatus 到位才画得出来 —— 数据确实在浏览器里取到了。
    await expect(page.getByText(/sources?$/)).toBeVisible();

    expect(errors).toEqual([]);
  });
});
