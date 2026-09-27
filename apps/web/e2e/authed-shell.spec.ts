import { expect, test } from "@playwright/test";
import { dismissPasskeyPrompt, signUpAndLogin } from "./fixtures/app";

// 登录后的页面弃 SSR、服务器只发骨架壳(ADR 0049 / FOL-34);补记之后连「服务器发」也没了 ——
// HTML 文档是构建期 prerender 出的静态文件,所有导航回同一份,Worker 不参与。
//
// 为什么这几条非 e2e 不可:要钉的是**发出去的那份 HTML 本身**——里面有没有数据、是不是同一份、
// 未登录的人最后落在哪。前两样在 HTTP 响应上,单测碰不到:路由的 `ssr` 选项与静态资源路由
// 都由框架 / 平台在真实请求里解析,mock 掉就等于把要验的东西替换掉了。
//
// 查 HTML 的几条走 `request`(裸 HTTP)而不是 `page.goto`:浏览器会执行 JS,会把「原样回了什么」抹掉。
// 查「最后落在哪」的那条反过来必须走浏览器 —— 跳转现在是客户端做的。

const AUTHED_PATHS = ["/", "/accounts", "/insights", "/settings"] as const;

// 水合报错是 recoverable error:React 抛、`page.on("console")` 一条都收不到,要听 `pageerror`
// (坑记在 no-hydration-mismatch.spec.ts)。构建产物里是压缩过的 `Minified React error #418` 那一族。
const IS_MISMATCH = /Hydration failed|hydration-mismatch|did not match|React error #(418|423|425)/i;

test.describe("未登录:拿到的是那张零数据的壳,浏览器再带去登录页", () => {
  for (const path of AUTHED_PATHS) {
    test(`${path} → 200 零数据壳,不是重定向`, async ({ request }) => {
      // 不带任何 cookie 的裸请求(fixture 里的 request 是全新 context,本来就没有会话)。
      // 以前这里是服务端 307;文档变成静态资源之后没有服务端判定可做了(ADR 0049 补记)。
      const res = await request.get(path, { maxRedirects: 0 });
      expect(res.status()).toBe(200);
      const html = await res.text();
      expect(html).toContain('data-slot="skeleton"');
      // 登录页的营销 hero 不在壳里 —— 壳与地址无关,不是哪一页烤进去的。
      expect(html).not.toContain("Total net worth");
    });

    test(`${path} → 浏览器里被带去 /login,期间不报水合错误`, async ({ page }) => {
      const errors: string[] = [];
      page.on("pageerror", (e) => {
        if (IS_MISMATCH.test(e.message)) errors.push(e.message.slice(0, 200));
      });
      await page.goto(path);
      await expect(page).toHaveURL(/\/login$/);
      await expect(page.getByLabel(/email/i)).toBeVisible();
      expect(errors).toEqual([]);
    });
  }

  // 壳是按 `/` prerender 的,却要给 /login 补水 —— 这一帧若渲的是路由,两边必然对不上。
  // 根上那层 `ClientOnly` 骨架就是为这条存在的(见 -root/root-document)。
  test("/login 硬加载不报水合错误", async ({ page }) => {
    const errors: string[] = [];
    page.on("pageerror", (e) => {
      if (IS_MISMATCH.test(e.message)) errors.push(e.message.slice(0, 200));
    });
    await page.goto("/login");
    await expect(page.getByLabel(/email/i)).toBeVisible();
    await page.waitForLoadState("networkidle");
    expect(errors).toEqual([]);
  });

  test("/login 与登录后各页是同一份字节", async ({ request }) => {
    // 只有构建产物才是「同一份静态文件」;本地 dev server 每个请求现渲一次(payload 里的时刻各不相同)。
    test.skip(!process.env.CI, "dev server 不出静态壳,这条只对构建产物(CI 的 preview)成立");
    const login = await (await request.get("/login", { maxRedirects: 0 })).text();
    expect(login).toContain("<!DOCTYPE html>");
    for (const path of AUTHED_PATHS) {
      expect(await (await request.get(path, { maxRedirects: 0 })).text(), path).toBe(login);
    }
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
