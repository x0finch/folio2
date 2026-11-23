import { expect, test } from "@playwright/test";
import { dismissPasskeyPrompt, signUpAndLogin } from "./fixtures/app";

// Press feedback can fail silently (class present, nothing rendered), so measure computed styles
// while held; jsdom has no cascade. Not covered: iOS Safari only applies `:active` with a touch
// listener (the empty `onTouchStart`) — Chromium doesn't need it, so verify that on a real device.

test.describe("Dock press feedback", () => {
  // The Dock only renders at the phone breakpoint.
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true });

  test("holding an icon shrinks and fades it, releasing restores it", async ({ page }) => {
    await signUpAndLogin(page);
    await dismissPasskeyPrompt(page);
    await page.goto("/");

    // `nav.fixed` scopes to the Dock; the desktop sidebar has a link with the same href.
    const link = page.locator('nav.fixed a[href="/insights"]');
    await expect(link).toBeVisible({ timeout: 30_000 });

    const icon = link.locator("span").first();
    const read = () =>
      icon.evaluate((el) => {
        const cs = getComputedStyle(el);
        return { scale: cs.scale, opacity: cs.opacity };
      });

    expect(await read()).toEqual({ scale: "none", opacity: "1" });

    const box = await link.boundingBox();
    if (!box) throw new Error("dock link has no box");
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();

    // Wait out the 100ms transition.
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
