import { expect, test } from "@playwright/test";
import { dismissPasskeyPrompt, signUpAndLogin } from "./fixtures/app";

// 一个路由 + `<Activity>` 保活的 page 切换器(FOL-81 / ADR 0052)。验的是这套机制**只有在浏览器里
// 才成立**的那几件:切 page 只换可见组件、去过的页保活(页内 state 切走再回来还在)、深链直达、
// 切换全程不抛错。URL / 后退 / 跨页 / 组合那几件由 `portfolio-url.spec` 管,这里不重复。
//
// **为什么保活这条非 e2e 不可**:它整个成立在「四个 page 同挂一棵树、切 page 只翻 Activity 可见性」
// 上。挂掉的方式很静默 —— 若合并路由在 `params.page` 变时把组件重建了(旧的四路由方案就是每切一下
// 重建一次),`dim` 会悄悄回落默认,页面照常能用,只是「回来发现白翻过」。单测碰不到这一层。

test.describe("page 切换器:一个路由 + Activity 保活", () => {
  test.describe.configure({ timeout: 60_000 });

  test("切走再回来页内状态还在;深链直达;切换零报错", async ({ page }) => {
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(String(e)));

    await signUpAndLogin(page);
    await dismissPasskeyPrompt(page);

    // —— 深链直达洞察页(合并路由后 `/insights` 仍直接打开这一页)——
    await page.goto("/insights");
    await expect(page).toHaveURL(/\/insights$/);
    const byChain = page.getByRole("tab", { name: "By chain" });
    await expect(byChain).toBeVisible();

    // —— 在洞察页把分布维度切成非默认(现住组件内部 state,不进 URL)——
    // 首个交互用 `toPass` 包着:补水完成前的点击会被静静吞掉(见 fixtures/app.ts 注释),重试到生效。
    await expect(async () => {
      await byChain.click();
      await expect(byChain).toHaveAttribute("aria-selected", "true");
    }).toPass({ timeout: 15_000 });
    await expect(page).toHaveURL(/\/insights$/); // 切维度不动地址

    // —— 切到总览、再切回洞察 —— Activity 保活:洞察那份组件 state 应当原样还在 ——
    await page.locator('aside a[href="/"]').first().click();
    await expect(page).toHaveURL(/\/$/);
    await page.locator('aside a[href^="/insights"]').click();
    await expect(page).toHaveURL(/\/insights$/);
    // 关键断言:回到洞察,"By chain" 仍选中 —— 组件没被卸载重建(旧的四路由方案这里会回落默认维度)。
    await expect(byChain).toHaveAttribute("aria-selected", "true");

    expect(errors, `pageerror during switching: ${errors.join("; ")}`).toEqual([]);
  });
});
