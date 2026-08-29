import { expect, test } from "@playwright/test";
import { dismissPasskeyPrompt, signUpAndLogin } from "./fixtures/app";

// 手记账户抽屉的 Tokens tab 是 `<TokenRowContent>` 的**第三条**渲染路径(首页、非-manual 抽屉各一条)。
// #447 第 5、6 片把前两条接上了、漏了这条:server 把 24h 盈亏算好也送到了行上,面板却没往下传。
//
// **为什么这条非 e2e 不可。** 漏传一个 prop 的后果是静默的 —— `undefined` 让增量那一行整个不渲染,
// 看起来像「手记账户没有这个功能」,而不像坏了。挡它需要跨过整条链:server 算 → 查询 → 合并成行 →
// 抽屉 → 面板 → 行。中间任一环把字段丢了,表现完全一样。
//
// 单测那两层各管一头,都没盖住这里:
//   · `token-row-gain-wired.test.ts` 扫源码,能挡「哪条路径漏传」,但不验真渲染出了什么;
//   · 组件级渲染测试试过,放弃了 —— 这个面板的依赖链一路链到 `cloudflare:workers`,要打的桩
//     一个套一个(查询、四个 server fn、选币下拉…),那样的测试将来加个 import 就红,而红的原因
//     与被测行为无关。
//
// 这里不需要造「24 小时前」的数据:新建的手记账户不满 24 小时,没有起点 → 盈亏是 **null**
// (ADR 0050:绝不拿首笔活动冒充 24h 基准),界面渲染 `—`。而「null 画 `—`」与「undefined
// 整行不渲染」在界面上必须长得不一样 —— 这个三态区分正是漏传时会塌掉的那一格。

test.describe("手记账户的 24h 盈亏", () => {
  test.describe.configure({ timeout: 120_000 });

  test("Tokens 那行渲染出增量位(哪怕是 `—`),而不是整行不见", async ({ page }) => {
    await signUpAndLogin(page);
    await dismissPasskeyPrompt(page);
    await page.goto("/accounts");

    // —— 建一个手记账户,顺手填一笔持仓 ——
    // 点到 modal 真开为止:刚 goto 完 React 可能还没挂上 handler,那一下点击会被静静吞掉
    // (见 fixtures/sync.ts addBinanceAccount 的注释,同一个坑)。
    const scrim = page.getByRole("button", { name: "Close modal" });
    await expect(async () => {
      if ((await scrim.count()) === 0) {
        await page.getByRole("button", { name: /add account/i }).click();
      }
      await expect(page.getByRole("button", { name: /Manual$/i })).toBeVisible({ timeout: 2_000 });
    }).toPass({ timeout: 30_000 });

    await page.getByRole("button", { name: /Manual$/i }).click();

    // 选币下拉要联网搜索;切成纯文本输入,e2e 不碰上游。
    await page.getByRole("button", { name: /enter a symbol manually/i }).click();
    await page.locator("#m-token").fill("BTC");
    await page.locator("#m-amount").fill("2");
    await page.locator("#m-price").fill("50000");
    await page.locator("#add-label").fill("E2E Manual");

    // 回车提交而不是点按钮:遮罩是个覆盖全屏的关闭按钮,morph 动画期间那一下会被它接走
    // (同 addBinanceAccount 的注释)。
    await page.locator("#add-label").press("Enter");
    await expect(scrim).toHaveCount(0, { timeout: 30_000 });

    // —— 打开它的抽屉 ——
    const row = page.getByRole("button").filter({ hasText: "E2E Manual" });
    await expect(row).toBeVisible({ timeout: 30_000 });
    await row.click();

    // 抽屉头的市值 —— 2 × 50000
    await expect(page.getByText("$100,000.00").first()).toBeVisible({ timeout: 30_000 });

    // —— 断言那一行确实带着增量位 ——
    // 账户不满 24 小时 → 盈亏 null(ADR 0050)→ 渲染 `—`。漏传时这一行整个不存在。
    // 这一屏上这个符号应该出现**三处**:
    //   ① 账户列表那一行  ② 抽屉头  ③ 抽屉里 Tokens 那一行
    // 三处分别走 <ValueDelta>、抽屉头手搓的那块、以及 <TokenRowContent> —— 正是要统一的三条路。
    // 漏传时第三处整行不渲染,数目掉到 2:这个计数就是那个 bug 的精确形状。
    //
    // 不去按 DOM 结构定位那一行:行是层层嵌套的 div,`.last()` 取到的是最内层的小块(试过两轮,
    // 一次取到名称格、一次取到 Activity 列表里那条同样含「2 BTC」的活动),按文本计数反而稳。
    await expect(page.getByText("—", { exact: true })).toHaveCount(3);
  });
});
