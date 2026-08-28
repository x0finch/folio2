import { expect, type Page, test } from "@playwright/test";
import { dismissPasskeyPrompt, signUpAndLogin } from "./fixtures/app";

// 选中的 Portfolio 住 URL(ADR 0046)。这一条只测**浏览器里才组合得起来**的那几件:
// 切组合后地址长出参数、页头的同步摘要跟着换、后退键回到上一个组合、刷新后仍在原组合、
// 逛设置往返参数还在、切组合把属于旧组合的参数丢掉、切回默认参数消失。两条纯规则(读回哪个组合 / 切换后的新查询串)
// 已由 `tests/portfolio-selection.test.ts` 钉住,这里不重复。
//
// **为什么非 e2e 不可**:每一件都要「地址 + 历史栈 + search 中间件 + 路由 loader」四样同时在场才成立,
// 而挂掉的方式都很静默 —— 忘了跨页保留只是「改个设置回来组合变了」;忘了 push 只是「后退键跳过了刚才
// 那次切换」;忘了清旧参数只是「新组合里带着上一个组合的视角」。三种在单测里都长得像正常。
//
// 造第二个组合只能走一遍真 UI:新建组合的入口住在账户抽屉的「移到组合」里(选择器自己要 ≥2 个组合
// 才出现,是个鸡生蛋),所以先建一个手记账户。这也顺带让两个组合**看起来不一样** ——
// 默认那个有一个账户,新的那个是空的,于是「屏幕跟着地址变」有东西可断言。
//
// **刷新与后退分两段验,不串在一起**:页面刚 load 完那几百毫秒里按后退,router 会**漏掉**这一次
// popstate —— 它的订阅挂在 `Transitioner` 的 effect 里(`router.history.subscribe(router.load)`),
// 补水之前发生的 popstate 没有人在听,而 history 那侧不重放。表现是地址栏回去了、界面还停在旧组合
// (实测:刷新后立刻 `goBack` 复现,刷新后等一秒再 `goBack` 就正常)。真人按不出这个窗口(得在刷新
// 完成后的一瞬间按下后退),Playwright 按得出 —— 所以这里不制造那个竞态,而不是把它断言成正确行为。

const ACCOUNT = "E2E Manual";
const SECOND = "Watch";

test.describe("URL 里的组合选中态", () => {
  // 前戏是一串真 UI 动作(建账户 → 开抽屉 → 新建组合),比一般 spec 重,给整组放宽。
  test.describe.configure({ timeout: 120_000 });

  test("切组合上地址栏,后退 / 刷新 / 跨页都跟着它", async ({ page }) => {
    const user = await signUpAndLogin(page);
    // 默认组合的名字由注册名派生(`<name>'s`,见 @folio/db 的 ensureDefault),每次跑都不一样 ——
    // 所以算出来用,而不是在页面上按形状猜哪一行是它。
    const DEFAULT = `${user.name}'s`;
    await dismissPasskeyPrompt(page);
    await page.goto("/accounts");
    await addManualAccount(page);
    await addPortfolio(page, SECOND);

    // 选择器出现 = 第二个组合真的建出来了(它 ≥2 个组合才渲染)。
    await expect(page.getByRole("button", { name: "Portfolio", exact: true })).toBeVisible({
      timeout: 30_000,
    });
    // 默认组合的地址是干净的 —— 默认那个不写进 URL。
    await expect(page).toHaveURL(/\/accounts$/);
    const row = page.getByRole("button").filter({ hasText: ACCOUNT }).first();
    await expect(row).toBeVisible();
    // 页头摘要的基线:默认组合里那一个手记账户。
    await expect(sourceCount(page)).toHaveText("1");

    // —— ① 切到非默认组合:地址长出参数,屏幕跟着换 ——
    await switchTo(page, SECOND);
    await expect(page).toHaveURL(/\/accounts\?portfolio=[^&]+$/);
    const watchUrl = page.url();
    // 新组合里还没有账户。**先按可见性筛,再断言**:这一页在换数据时 DOM 里会同时存在两份名单
    // (React 把旧的那份留着、加 `hidden`,直到新数据就绪 —— 那正是「不闪骨架」的机制)。
    // 只写 `toBeVisible()` 挡不住:strict mode 先算「命中几个」,两个就直接报错,而 `getByText`
    // 是连隐藏的一起认的(CI 上实测,本地跑不出来)。
    await expect(emptyList(page)).toBeVisible();
    // 页头那块同步摘要也换了 —— 它按选中的组合另取一份,不是全局的那一份。
    await expect(sourceCount(page)).toHaveText("0");

    // —— ② 后退键撤销这一次切换(所以切组合走 `push` 而不是 `replace`)——
    await page.goBack();
    await expect(page).toHaveURL(/\/accounts$/);
    await expect(row).toBeVisible();
    await expect(sourceCount(page)).toHaveText("1");

    // —— ③ 刷新:仍在这个组合(以前刷一下就回默认了)——
    await switchTo(page, SECOND);
    await expect(page).toHaveURL(watchUrl);
    await page.reload();
    await expect(page).toHaveURL(watchUrl);
    await expect(emptyList(page)).toBeVisible();

    // —— ④ 逛一趟设置再回来,参数还在 ——
    // 走侧栏链接(客户端导航)而不是 `goto`:要验的正是「链接身上自动带着这个参数」,而这件事由布局层的
    // `retainSearchParams` 负责,没有哪个调用点写过它。
    //
    // 用 `toPass` 包着点:上面刚刷新过,补水完成之前的那一下点击会被**静静吞掉**(不报错、不生效,
    // 见 fixtures/app.ts 里 gotoHydrated 那段注释)。重试到真的导航过去为止。
    await expect(async () => {
      await page.locator('aside a[href^="/settings"]').click();
      await expect(page).toHaveURL(/\/settings\?portfolio=/, { timeout: 2_000 });
    }).toPass({ timeout: 30_000 });
    await page.locator('aside a[href^="/accounts"]').click();
    await expect(page).toHaveURL(watchUrl);

    // —— ⑤ 切组合 = 一份全新的查询串:属于旧组合那一套视角参数不跟着走 ——
    // 在 Insights 上选一个非默认的分布维度(`?dim=`)。**为什么用它而不是账户抽屉的 `?account=`**:
    // 抽屉一开,它的遮罩就盖住整个页头 —— 连选择器都点不到,那条组合根本走不出来。
    await page.locator('aside a[href^="/insights"]').click();
    await expect(page).toHaveURL(/\/insights\?portfolio=/);
    await page.getByRole("tab", { name: "By chain" }).click();
    await expect(page).toHaveURL(/dim=chain/);
    await expect(page).toHaveURL(/portfolio=/);

    // —— ⑥ 切回默认:参数全消失(`dim` 与组合无关也不留 —— 「切组合就是从头开始」)——
    await switchTo(page, DEFAULT);
    await expect(page).toHaveURL(/\/insights$/);
  });
});

/** 「还没有账户」那句 —— 只认**看得见**的那一份(见上面第 ① 步的注释)。 */
const emptyList = (page: Page) => page.getByText("No accounts yet.").filter({ visible: true });

/**
 * 页头同步面板里「来源 N」那个数字。
 *
 * 这份摘要按选中的组合另取一份(`ShellWithSync` 在 Provider **之内**取),所以这个数字是「页头跟着
 * 组合走」最直接的证据:谁把那个查询挪回 Provider 外面,它就永远显示默认组合那一份,这里当场红。
 *
 * 不先 hover 把面板打开:内容一直在 DOM 里(弹层只是收着),而要验的是数据接对没接对,不是弹层动效。
 *
 * **锚点从「Sources synced N / M」换成了这一行**(ADR 0048):同步的口径改成了三段式,而三段式是
 * 关于**某一轮**的报告 —— 这条 spec 里一轮都没跑过(手记账户不进轮),所以面板走的是无轮态,
 * 那一行说的正是「这个组合有几个来源」。要的性质没变,而且这个数比原来那个分数更贴题:
 * 它就是「当前组合里有几个来源」,与同步跑没跑过无关。
 *
 * `exact` 不能省:`getByText` 收字符串时是**大小写不敏感的子串**匹配,而页头副标题写着
 * 「across N sources」—— 不锚死会同时命中它,strict mode 直接报两个元素。
 */
const sourceCount = (page: Page) =>
  page.getByText("Sources", { exact: true }).locator("xpath=following-sibling::span[1]");

/**
 * 从页头的选择器切到某个组合。
 *
 * 选择器是 hover 浮出的弹层:先 hover 触发器,再点选项 —— 两者上下相邻,鼠标直线过去不会掠过别处。
 * `exact` 是必须的:裸的 "Portfolio" 会连同一个弹层里的「Manage portfolios」一起命中(实测 strict
 * mode 直接报两个元素)。
 */
async function switchTo(page: Page, name: string) {
  await page.getByRole("button", { name: "Portfolio", exact: true }).hover();
  await page.getByRole("button", { name, exact: true }).first().click();
}

/** 建一个手记账户(不联网、必定成功)。步骤与坑同 `manual-gain.spec.ts`,那边有逐条注释。 */
async function addManualAccount(page: Page) {
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
  await page.locator("#add-label").fill(ACCOUNT);
  // 回车提交:遮罩是个覆盖全屏的关闭按钮,morph 动画期间点按钮那一下会被它接走。
  await page.locator("#add-label").press("Enter");
  await expect(scrim).toHaveCount(0, { timeout: 30_000 });
}

/**
 * 再建一个组合。入口只有一处:账户抽屉 → 更多操作 → 移到组合 → 左下角「新建组合」。
 * 建完不点选(不搬账户),直接**整页重载**收场 —— 比逐层关掉抽屉与弹窗稳,而且这条 spec 接下来
 * 每一步都要从一个干净的账户页开始。
 */
async function addPortfolio(page: Page, name: string) {
  await page.getByRole("button").filter({ hasText: ACCOUNT }).first().click();
  await page.getByRole("button", { name: "More actions" }).hover();
  await page.getByRole("button", { name: /move to/i }).click();
  // 这个入口的文案在 hover / 聚焦时会换成「Click to create」(AnimatedBadge 的 text-roll),两种都认。
  await page.getByRole("button", { name: /new portfolio|click to create/i }).click();
  await page.getByPlaceholder("New portfolio name").fill(name);
  await page.getByRole("button", { name: "Create", exact: true }).click();
  // 建完回到「移到组合」列表,新组合出现在里面 —— 以此确认创建真的成功了。
  await expect(page.getByRole("button", { name, exact: true }).first()).toBeVisible({
    timeout: 30_000,
  });
  await page.goto("/accounts");
}
