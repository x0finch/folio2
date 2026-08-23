import { expect, type Page, test } from "@playwright/test";
import { dismissPasskeyPrompt, signUpAndLogin } from "./fixtures/app";

// **首屏不许出 hydration mismatch。**
//
// 为什么非 e2e 不可:这个 bug 唯一的症状是控制台一条 React 报错 + 那棵子树被丢掉重渲一遍。
// 界面最终是对的,四闸全绿,单测全绿 —— 它在仓库里活了很久,是有人打开控制台才看见的。
// 挡它需要**两遍渲染都真的发生**:服务端渲一遍、浏览器补水再渲一遍,然后比较。只有真浏览器做得到。
//
// 隔壁那几条 source-grep 测试(`home-progressive` / `accounts-progressive` / `insights-loader`)
// 挡的是「别退回那几种写法」;这一条挡的是**结果**。两者都要:前者说得出哪里错了,
// 后者不依赖我们猜得到所有错法。
//
// 出错时怎么读:报错正文里 `+` 是服务端渲的、`-` 是客户端补水那一帧渲的。多半是某个
// 「后到的数据」服务端已经有、客户端补水那一帧还没有 —— 那类查询该走挂起 + `QueryBoundary`,
// 不该用 `useQuery` + `isPending` 判骨架(理由见 `-home/hero/index.tsx` 开头)。
//
// —— **写这条测试时踩过的三个坑,都是实测出来的,别再踩** ——
//
// ① **必须先有持仓。** 拿刚注册的空用户跑,把那四个岛回退成出问题的写法照样绿 —— 没有数据就
//    没有「服务端算出了值、客户端补水那一帧还没有」这回事,两边都渲空态。
// ② **必须听 `pageerror`,不能只听 `console`。** React 把它当 recoverable error 抛,dev 下被
//    vite 的客户端接走转发(服务端日志里那句 `[vite] (client) [Unhandled error]`)——
//    `page.on("console")` 一条都收不到。实测:mismatch 明明在发生,console 计数是 0。
// ③ **要跑两轮。** 第一轮只抓到 `/accounts` 一页;服务端缓存热了之后它才在更多页上赢下那场
//    竞速。两轮给足余量。
//
// **负对照(把那四个岛 `git checkout main --` 回去再跑)**:三轮分别抓到 1 / 2 / 2 条,
// 每轮都 ≥1;改回来之后 0 / 0 / 0。所以这条测试不是装饰。

const PAGES = ["/", "/accounts", "/insights"] as const;
const ROUNDS = [1, 2];

// 照抄 `manual-gain.spec.ts` 的建号流程(那些 `toPass` / 回车提交的绕法各有注释在那边)。
async function seedHolding(page: Page) {
  await page.goto("/accounts");
  const scrim = page.getByRole("button", { name: "Close modal" });
  await expect(async () => {
    if ((await scrim.count()) === 0) {
      await page.getByRole("button", { name: /add account/i }).click();
    }
    await expect(page.getByRole("button", { name: /Manual$/i })).toBeVisible({ timeout: 2_000 });
  }).toPass({ timeout: 30_000 });
  await page.getByRole("button", { name: /Manual$/i }).click();
  await page.getByRole("button", { name: /enter a symbol manually/i }).click();
  await page.locator("#m-token").fill("BTC");
  await page.locator("#m-amount").fill("2");
  await page.locator("#m-price").fill("50000");
  await page.locator("#add-label").fill("E2E Hydration");
  await page.locator("#add-label").press("Enter");
  await expect(scrim).toHaveCount(0, { timeout: 30_000 });
  await expect(page.getByRole("button").filter({ hasText: "E2E Hydration" })).toBeVisible({
    timeout: 30_000,
  });
}

const IS_MISMATCH = /Hydration failed|hydration-mismatch|did not match/i;

test.describe("首屏 hydration", () => {
  test.describe.configure({ timeout: 180_000 });

  test("三页冷加载都不报 hydration mismatch", async ({ page }) => {
    const hits: string[] = [];
    // `pageerror` 是真正会响的那个(见上面坑 ②);`console` 一并收着,免得哪天 React 或 vite
    // 改了投递方式,这条测试静默变空。
    page.on("pageerror", (e) => {
      if (IS_MISMATCH.test(e.message)) hits.push(`${page.url()} :: ${e.message.slice(0, 160)}`);
    });
    page.on("console", (m) => {
      if (IS_MISMATCH.test(m.text())) hits.push(`${page.url()} :: ${m.text().slice(0, 160)}`);
    });

    await signUpAndLogin(page);
    await dismissPasskeyPrompt(page);
    await seedHolding(page);
    // 建号那一路走的是 modal 和表单,不是这条测试的题目 —— 从这儿开始数。
    hits.length = 0;

    for (const _round of ROUNDS) {
      for (const path of PAGES) {
        // 整页导航才会补水;客户端导航不会。
        await page.goto(path);
        // 岛屿是分批亮的,mismatch 出在后到的那几批身上 —— 等到它们都落地。
        await page.waitForLoadState("networkidle");
      }
    }

    expect(hits).toEqual([]);
  });
});
