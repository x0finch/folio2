import { expect, test } from "@playwright/test";
import { dismissPasskeyPrompt, signUpAndLogin } from "./fixtures/app";

// Dock 的按下反馈(片3 / #470)。
//
// **为什么非 e2e 不可**:这一片的第一版用 motion 的 `whileTap`,在真机上**完全没有反应** —— 而它
// 「看起来」是对的:DOM 里那层 span 在、链接照常导航、单测全绿。按住时既没有 transform 也没有内联
// 样式,是量出来才知道的。会静默失效的东西必须由「按住 → 量」来挡,不能由「类名在不在」来挡:
// 类名那种断言换个实现方式(比如又换回 motion)照样绿。
//
// 量的是**层叠算完的结果**,所以 base 层被谁盖了、变体前缀写错了、`transition` 把值吃了,都会红。
// jsdom 没有层叠,这条在单测里不可能存在。
//
// 唯一量不到的一点:iOS Safari 只在元素挂了触摸监听时才给 `:active`(代码里那个空 `onTouchStart`
// 就是为它留的)。Chromium 不需要那把钥匙,所以删掉它这条测试照样绿 —— 那半只能真机验,已验过。

test.describe("Dock 按下反馈", () => {
  // Dock 只在手机断点出现(桌面走侧栏),所以这一条得在手机视口里跑。
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true });

  test("按住图标会缩小变淡,松开复原", async ({ page }) => {
    await signUpAndLogin(page);
    await dismissPasskeyPrompt(page);
    await page.goto("/");

    // `nav.fixed` 限定的是 Dock 那个 nav —— 桌面侧栏里有同一个 href 的链接,不限定会撞上。
    const link = page.locator('nav.fixed a[href="/insights"]');
    await expect(link).toBeVisible({ timeout: 30_000 });

    const icon = link.locator("span").first();
    const read = () =>
      icon.evaluate((el) => {
        const cs = getComputedStyle(el);
        return { scale: cs.scale, opacity: cs.opacity };
      });

    expect(await read()).toEqual({ scale: "none", opacity: "1" });

    // 按住不放。松手会导航,那没关系 —— 要断言的都在按住这段时间里。
    const box = await link.boundingBox();
    if (!box) throw new Error("dock link has no box");
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();

    // 过渡是 100ms,别在半路读。
    await expect(async () => {
      const held = await read();
      expect(held.scale).toBe("0.82");
      expect(Number(held.opacity)).toBeCloseTo(0.6, 2);
    }).toPass({ timeout: 5_000 });

    await page.mouse.up();

    await expect(async () => {
      expect(await read()).toEqual({ scale: "none", opacity: "1" });
    }).toPass({ timeout: 5_000 });
  });
});
