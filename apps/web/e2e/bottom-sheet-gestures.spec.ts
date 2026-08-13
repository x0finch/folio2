import { devices, expect, test } from "@playwright/test";
import { signUpAndLogin } from "./fixtures/app";

// 底部抽屉的**手势**回归(片8 / ADR 0041)。
//
// **为什么非 e2e 不可。** 落档策略本身有单测(`bottom-sheet-snap.test.ts`),但那一层测的是
// 「给定位移与速度,该落哪一档」;真机上出问题的是**策略与 motion 之间的接线**:
//   · 上一版让 motion 的惯性投影决定落点 → 换档距离恒等于半个间距,拖 120px 松手会弹回去;
//   · 目标等于当前档时 `setSnap` 写进去的值没变 → `animate` prop 不重跑 → 抽屉**卡在手指松开处**。
// 这两个都是「纯函数全绿、界面不对」,组件级测试也够不着(jsdom 没有布局、没有指针速度)。
//
// 这里用真触摸事件(CDP `Input.dispatchTouchEvent`)+ 真布局,断言抽屉**停在哪**。
// 观感(跟手顺不顺、曲线好不好看)仍然只有真机能判 —— 这组只保证「不再回到那两个错的行为」。
// 手机视口 + 触摸,写在文件顶层:`use` 里带 `defaultBrowserType` 会强制换 worker,
// Playwright 不允许它出现在 describe 里。
test.use({ viewport: devices["iPhone 13"].viewport, hasTouch: true, isMobile: true });

test.describe("底部抽屉的落档", () => {
  test.describe.configure({ timeout: 180_000 });

  test("拖过阈值落下一档;拖一点点回原档;猛甩下滑关闭", async ({ page, context }) => {
    await signUpAndLogin(page);

    // —— 造一个有持仓的手记账户(照 manual-gain.spec.ts) ——
    await page.goto("/accounts");
    const scrim = page.getByRole("button", { name: "Close modal" });
    await expect(async () => {
      if ((await scrim.count()) === 0) {
        await page
          .getByRole("button", { name: /add account/i })
          .first()
          .click();
      }
      await expect(page.getByRole("button", { name: /Manual$/i })).toBeVisible({ timeout: 2_000 });
    }).toPass({ timeout: 30_000 });
    await page.getByRole("button", { name: /Manual$/i }).click();
    await page.getByRole("button", { name: /enter a symbol manually/i }).click();
    await page.locator("#m-token").fill("BTC");
    await page.locator("#m-amount").fill("2");
    await page.locator("#m-price").fill("50000");
    await page.locator("#add-label").fill("Sheet Gestures");
    await page.locator("#add-label").press("Enter");
    await expect(scrim).toHaveCount(0, { timeout: 30_000 });

    await page.goto("/");
    const row = page
      .locator("[data-scroll-restoration-id] button, .app-scroll button")
      .filter({ hasText: /BTC/ })
      .first();
    await expect(row).toBeVisible({ timeout: 30_000 });
    await row.click();

    // 抽屉的顶边 —— 半档时它在屏幕中段。
    const sheetTop = async () => {
      const box = await page
        .locator('[role="dialog"][aria-modal="true"]')
        .first()
        .boundingBox({ timeout: 10_000 });
      if (!box) throw new Error("sheet not on screen");
      return Math.round(box.y);
    };
    // **等开合动画停稳再量**:开场那一下还在跑时量到的是中间值,拿它算出的落点会落到内容区而不是手柄
    // (第一版就是这样挂的:量到 435,真正的半档是 270)。
    const settled = async () => {
      let last = -1;
      for (let i = 0; i < 40; i++) {
        const now = await sheetTop();
        if (now === last) return now;
        last = now;
        await page.waitForTimeout(120);
      }
      throw new Error("sheet never settled");
    };
    const half = await settled();

    // CDP 真触摸:Playwright 的 touchscreen 只有 tap,拖拽得自己发事件。
    const cdp = await context.newCDPSession(page);
    const point = (y: number) => [{ x: 196, y, radiusX: 12, radiusY: 12, force: 1, id: 1 }];
    const drag = async (from: number, to: number, steps: number, stepMs = 12) => {
      await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: point(from) });
      for (let i = 1; i <= steps; i++) {
        await cdp.send("Input.dispatchTouchEvent", {
          type: "touchMove",
          touchPoints: point(from + ((to - from) * i) / steps),
        });
        await page.waitForTimeout(stepMs);
      }
      await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    };

    // ① 慢慢往上拖「四成间距」→ 落顶格。
    // **拖的距离按间距比例写,不写死像素**:换档阈值本身就是间距的两成,而间距随视口高度变 ——
    // 写死 px 的测试换个视口就会测成另一件事(第一版写 60px,在 664 高的视口上刚好越过阈值,
    // 于是把「该回原档」测成了「该换档」)。
    await drag(half + 14, half + 14 - Math.round(half * 0.4), 20);
    const top = await settled();
    expect(top).toBeLessThan(40);

    // ② 从顶格往下拖「一成间距」(远不到两成阈值)→ 回顶格,**不许卡在手指松开的位置**。
    // 上一版这里会停在松手那个位置(目标等于当前档 → state 没变 → 动画不重跑)。
    const gap = half - top;
    await drag(top + 14, top + 14 + Math.round(gap * 0.1), 14);
    expect(await settled()).toBeLessThan(40);

    // ③ 先回半档,再往下猛甩 → 关闭。
    // **一次手势只跨一档**(顶格猛甩下去也只到半档,不会一步跳 dismiss)—— 这条是有意的,
    // 单测里也钉着;所以要关掉得从半档甩。
    await drag(top + 14, top + 14 + Math.round(gap * 0.4), 12);
    const backToHalf = await settled();
    expect(backToHalf).toBeGreaterThan(top + 40);
    await drag(backToHalf + 14, backToHalf + 14 + gap, 6, 6);
    await expect(page.locator('[role="dialog"][aria-modal="true"]')).toHaveCount(0, {
      timeout: 15_000,
    });
  });
});
