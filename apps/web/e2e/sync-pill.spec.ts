import { expect, test } from "@playwright/test";
import { dismissPasskeyPrompt, signUpAndLogin } from "./fixtures/app";
import {
  addBinanceAccount,
  blockPostCreateSync,
  hoverSyncPill,
  setUpstream,
} from "./fixtures/sync";

// FOL-96:鼠标一移进同步胶囊,悬停面板就开始弹出 —— 开场那一帧面板内容的可见区域正好就是胶囊那一块,
// 而内容层压在胶囊上面。于是「移进来立刻点」的那一下:mousedown 落在胶囊、mouseup 落在面板,click
// 发给了两者的公共祖先,同步没触发。真人也会撞上(移入后约 100ms 内点下去)。
//
// 单测造不出来:要的是真浏览器的命中测试 + 弹层动画的真实时序。
test.describe("同步胶囊", () => {
  test.describe.configure({ timeout: 120_000 });

  test("鼠标移入后立刻点 → 照样发起同步,不被弹出的面板吞掉", async ({ page, request }) => {
    await setUpstream(request, { delayMs: 0, spotBtc: "1.50000000" });
    await signUpAndLogin(page);
    await dismissPasskeyPrompt(page);
    // 掐掉建账户之后那次自动同步:它会让胶囊在测试中途变成「Syncing…」,而在跑的时候点它不发请求
    // (sync() 在 busy 时直接 return)。这条测的是「点没点上」,不需要先有一轮同步。
    await blockPostCreateSync(page);
    await page.goto("/accounts");
    await addBinanceAccount(page, "Quick click");
    await page.reload();

    const pill = page.getByRole("button", { name: /^(Synced|Needs attention)$/ });
    await expect(pill).toBeVisible();
    // 先确认页面已补水(hover 能把面板打开),再把光标挪开、等面板收起 —— 下面那一下才是干净的「移入」。
    await hoverSyncPill(page);
    await page.mouse.move(0, 0);
    await expect(pill).toHaveAttribute("aria-expanded", "false", { timeout: 5_000 });

    const box = await pill.boundingBox();
    if (!box) throw new Error("同步胶囊不可见");
    const synced = page.waitForRequest(
      (r) => r.url().includes("/api/sync") && r.method() === "POST",
      { timeout: 5_000 },
    );
    // 移进来、立刻按下、松开 —— 中间不等面板开完。
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.up();
    await synced;
  });
});
