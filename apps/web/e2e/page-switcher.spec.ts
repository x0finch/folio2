import { expect, type Page, test } from "@playwright/test";
import { dismissPasskeyPrompt, signUpAndLogin } from "./fixtures/app";
import { accountIdByLabel, addBinanceAccount } from "./fixtures/sync";

// 一个路由 + `<Activity>` 保活的 page 切换器(FOL-81 / ADR 0053)。验的是这套机制**只有在浏览器里
// 才成立**的那几件(FOL-69 Testing Decisions):首访某页显示**该页自己的**骨架、回访即时无骨架、去过的页
// 保活(页内 state 切走再回来还在)、同步条不上下跳、严格 lazy(没进过的页不进树、chunk 不请求)、
// `?focus` 是一次性命令、切换全程不抛错。URL / 后退 / 跨页 / 组合那几件由 `portfolio-url.spec` 管,
// 这里不重复。手机视口、走 Dock:这套本来就是为手机做的(桌面走侧栏的路径由 `portfolio-url.spec` 走)。
//
// **为什么保活这条非 e2e 不可**:它整个成立在「四个 page 同挂一棵树、切 page 只翻 Activity 可见性」
// 上。挂掉的方式很静默 —— 若合并路由在 `params.page` 变时把组件重建了(旧的四路由方案就是每切一下
// 重建一次),`dim` 会悄悄回落默认,页面照常能用,只是「回来发现白翻过」。单测碰不到这一层。
//
// **骨架那两条怎么量得稳**:构建产物里一页的 chunk 几毫秒就到,骨架一闪即过、`toBeVisible` 追不上;
// 所以把**洞察那个 chunk 的响应**扣住 1.5 秒(按响应体里只有它才有的字面量认,不认文件名 —— 文件名带
// 散列、dev 与 build 又不一样)。回访「一次都不出现」用 MutationObserver 记:切换前装上、切换后读,
// 比「切完再数一遍」强 —— 后者抓不到一闪而过的那种。

// 洞察 / 账户两个 chunk 各自独有的字面量(源码里的字符串,压缩后原样保留):
// 走势卡数据边界的 resetKey 前缀;账户行的 DOM id 前缀。
const INSIGHTS_MARKER = "insights-trend:";
const ACCOUNTS_MARKER = "account-row-";
const INSIGHTS_CHUNK_DELAY_MS = 1_500;

// 拦所有脚本响应:记下哪几页的 chunk 被请求过(严格 lazy 的证据),并把洞察那个扣住一会儿。
async function interceptChunks(page: Page) {
  const requested = new Set<string>();
  await page.route(
    (url) => /\.(?:m?js|tsx?)(?:\?.*)?$/.test(url.pathname),
    async (route) => {
      const response = await route.fetch();
      const body = await response.text();
      if (body.includes(ACCOUNTS_MARKER)) requested.add("accounts");
      if (body.includes(INSIGHTS_MARKER)) {
        requested.add("insights");
        await new Promise((r) => setTimeout(r, INSIGHTS_CHUNK_DELAY_MS));
      }
      await route.fulfill({ response, body });
    },
  );
  return requested;
}

// 从现在起记下每一个被插进 DOM 的 `[data-page-skeleton]`(切换器给首访骨架挂的标记)。
async function watchSkeletons(page: Page) {
  await page.evaluate(() => {
    const seen: string[] = [];
    const record = (node: Node) => {
      if (!(node instanceof HTMLElement)) return;
      const own = node.dataset.pageSkeleton;
      if (own) seen.push(own);
      for (const el of node.querySelectorAll<HTMLElement>("[data-page-skeleton]")) {
        seen.push(el.dataset.pageSkeleton ?? "");
      }
    };
    new MutationObserver((records) => {
      for (const r of records) r.addedNodes.forEach(record);
    }).observe(document.body, { childList: true, subtree: true });
    (window as unknown as { __skeletons: string[] }).__skeletons = seen;
  });
}

const skeletonsSeen = (page: Page) =>
  page.evaluate(() => (window as unknown as { __skeletons: string[] }).__skeletons);

const headerSyncTop = async (page: Page) => {
  const box = await page.locator('[data-slot="header-sync"]:visible').boundingBox();
  if (!box) throw new Error("页头同步条不可见");
  return box.y;
};

test.describe("page 切换器:一个路由 + Activity 保活", () => {
  test.describe.configure({ timeout: 90_000 });
  // iPhone 12/13/14 的逻辑分辨率;Dock 只在手机断点出现。
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true });

  test("首访自己的骨架、回访无骨架、保活、同步条不跳、严格 lazy、零报错", async ({ page }) => {
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(String(e)));
    const requested = await interceptChunks(page);

    await signUpAndLogin(page);
    await dismissPasskeyPrompt(page);

    // —— 冷:深链直达洞察页 ——
    await page.goto("/insights");
    await expect(page).toHaveURL(/\/insights$/);
    // 首访显示的是**洞察自己的**骨架(chunk 被扣住,这一段看得见)……
    await expect(page.locator('[data-page-skeleton="insights"]')).toBeVisible();
    // ……chunk 到了原地换真页,骨架撤走。
    const byChain = page.getByRole("tab", { name: "By chain" });
    await expect(byChain).toBeVisible();
    await expect(page.locator("[data-page-skeleton]")).toHaveCount(0);

    // 严格 lazy:没进过的页不在树上,它们的 chunk 也没请求过(总览在这份文档里也还没进过)。
    await expect(page.locator('[data-page="accounts"]')).toHaveCount(0);
    await expect(page.locator('[data-page="overview"]')).toHaveCount(0);
    expect(requested.has("accounts"), "账户页没进过,它的 chunk 不该被请求").toBe(false);

    // —— 在洞察页把分布维度切成非默认(住组件内部 state,不进 URL)——
    // 首个交互用 `toPass` 包着:补水完成前的点击会被静静吞掉(见 fixtures/app.ts 注释),重试到生效。
    await expect(async () => {
      await byChain.click();
      await expect(byChain).toHaveAttribute("aria-selected", "true");
    }).toPass({ timeout: 15_000 });
    await expect(page).toHaveURL(/\/insights$/); // 切维度不动地址

    // —— 热:Dock 切到总览、再切回洞察 ——
    const topBefore = await headerSyncTop(page);
    await page.locator('nav.fixed a[href="/"]').click();
    await expect(page).toHaveURL(/\/$/);
    await expect(page.locator('[data-page="overview"]')).toBeVisible();
    // 同步条稳稳不动:它每页都一样、absolute 到外壳 <main>,不该跟着页面内容进场。
    expect(await headerSyncTop(page)).toBe(topBefore);

    await watchSkeletons(page);
    await page.locator('nav.fixed a[href="/insights"]').click();
    await expect(page).toHaveURL(/\/insights$/);
    // 保活:回到洞察,"By chain" 仍选中 —— 组件没被卸载重建(旧的四路由方案这里会回落默认维度)。
    await expect(byChain).toHaveAttribute("aria-selected", "true");
    // 回访即时、无骨架:切换以来一个洞察骨架都没插进过 DOM。
    expect(await skeletonsSeen(page)).not.toContain("insights");
    expect(await headerSyncTop(page)).toBe(topBefore);
    // 两页都还在树上(保活),账户页仍没进过。
    await expect(page.locator('[data-page="overview"]')).toHaveCount(1);
    await expect(page.locator('[data-page="accounts"]')).toHaveCount(0);

    expect(errors, `pageerror during switching: ${errors.join("; ")}`).toEqual([]);
  });

  test("认不出的路径段是 404,不是一张空白的外壳", async ({ page }) => {
    await signUpAndLogin(page);
    await dismissPasskeyPrompt(page);
    // 可选参数本身不限值 —— 不拦的话 `/anything` 会匹配到合并路由、外壳照渲、内容区空白。
    await page.goto("/anything");
    await expect(page.getByText("Not Found")).toBeVisible();
    await expect(page.locator("[data-page]")).toHaveCount(0);
  });

  test("?focus 是一次性命令:到账户页定位那一行,随即从地址上抹掉", async ({ page }) => {
    await signUpAndLogin(page);
    await dismissPasskeyPrompt(page);
    await page.goto("/accounts");
    await addBinanceAccount(page, "E2E Focus");
    const id = await accountIdByLabel(page, "E2E Focus");

    // 同步面板跨页跳到账户页时写的就是这个地址(`?focus=<id>`)。
    await page.goto(`/accounts?focus=${id}`);
    // 那一行在;地址上的 `focus` 被 `replace` 抹掉 —— 它是命令,不是状态,刷新不该再定位一次。
    await expect(page.locator(`[id="account-row-${id}"]`)).toBeVisible();
    await expect(page).toHaveURL(/\/accounts$/);
  });
});
