import { expect, test } from "@playwright/test";
import { dismissPasskeyPrompt, signUpAndLogin } from "./fixtures/app";
import { accountIdByLabel, addBinanceAccount, waitForSnapshot } from "./fixtures/sync";

// 手机窄屏首页不横向溢出(FOL-44 验收项;守 #540「the mobile page always outgrows the screen」的回归)。
//
// **为什么非 e2e 不可、且必须量而不是看。** 横向溢出是布局层的涌现结果 —— 某个 min-width、不换行的
// 长数字、或没夹住的 flex 子项把整页顶宽,任何单测 / 组件测都算不出来,只有真浏览器排完版才知道。
// 判据用 `scrollWidth <= clientWidth`(canonical 的「有没有横向滚动」):clientWidth 已排除滚动条,
// 两者一比就是溢出量,不靠肉眼看截图(那样会得出错误结论)。
//
// 要有数据再量:空态的窄屏几乎不会溢出,真正把页面顶宽的是持仓行里的长符号 / 大数字,所以先同步
// 一个账户拿到快照再量终态。
test.describe("手机窄屏:首页不横向溢出", () => {
  test.describe.configure({ timeout: 120_000 });
  // iPhone 12/13/14 的逻辑分辨率(CSS px)——最常见的一档窄屏。
  test.use({ viewport: { width: 390, height: 844 } });

  test("同步出数据后,首页在 390px 宽下 body 不超过视口", async ({ page }) => {
    await signUpAndLogin(page);
    await dismissPasskeyPrompt(page);
    await page.goto("/accounts");
    // 这里**不**掐后台同步 —— 要的正是它落一张快照,好量「有持仓行」时的布局。
    await addBinanceAccount(page, "E2E Mobile");
    const id = await accountIdByLabel(page, "E2E Mobile");
    await waitForSnapshot(
      page,
      id,
      (s) => s.balances.length > 0,
      "同步没落库,量不到有数据时的布局",
    );

    await page.goto("/");
    // 等 pending 态退场(hero 不再是骨架):骨架期的宽度与终态可能不同,量终态才作数。
    await expect(page.getByText("Syncing…")).toHaveCount(0, { timeout: 30_000 });

    const { scrollWidth, clientWidth } = await page.evaluate(() => {
      const el = document.documentElement;
      return { scrollWidth: el.scrollWidth, clientWidth: el.clientWidth };
    });
    expect(scrollWidth, `首页横向溢出 ${scrollWidth - clientWidth}px`).toBeLessThanOrEqual(
      clientWidth,
    );
  });
});
