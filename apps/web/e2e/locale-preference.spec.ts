import { expect, test } from "@playwright/test";

// 界面语言住浏览器(localStorage,ADR 0049 补记)。HTML 是构建期按默认语言(英文)渲的同一份静态文件,
// 所以「中文用户的首帧也是中文」全靠 <head> 里那段内联脚本 + 闪屏样式按 `<html lang>` 选文案 ——
// 单测只能对照脚本与 pickLocale 的逻辑,**首帧真的画成什么样**只有真浏览器看得到。
//
// 第一段扣住所有模块脚本:页面停在「静态壳 + 内联脚本跑过」那一刻,也就是补水之前用户看到的样子。

const IS_MISMATCH = /Hydration failed|hydration-mismatch|did not match|React error #(418|423|425)/i;

test.describe("选过中文", () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => localStorage.setItem("folio_locale", "zh"));
  });

  test("补水之前 <html lang> 与闪屏那行就已经是中文", async ({ page }) => {
    await page.route(/\/assets\/.+\.js$/, (route) => route.abort());
    await page.goto("/login");
    await expect(page.locator("html")).toHaveAttribute("lang", "zh");
    // innerText 不含 display:none 的那条 —— 两种语言都在 DOM 里,只露一条。
    await expect(page.locator("#folio-splash-msg")).toHaveText("准备中…", { useInnerText: true });
  });

  test("补水后界面是中文,期间不报水合错误", async ({ page }) => {
    const errors: string[] = [];
    page.on("pageerror", (e) => {
      if (IS_MISMATCH.test(e.message)) errors.push(e.message.slice(0, 200));
    });
    await page.goto("/login");
    await expect(page.getByLabel("邮箱")).toBeVisible();
    await expect(page.locator("html")).toHaveAttribute("lang", "zh");
    expect(errors).toEqual([]);
  });
});

test("在登录页切到英文 → 刷新后仍是英文(偏好落在浏览器里)", async ({ page }) => {
  await page.goto("/login");
  await page.evaluate(() => localStorage.setItem("folio_locale", "zh"));
  await page.reload();
  await expect(page.getByLabel("邮箱")).toBeVisible();
  // 补水完成前的点击会被静静吞掉(见 fixtures/app.ts 注释),重试到生效。
  await expect(async () => {
    await page.getByRole("button", { name: "EN", exact: true }).click();
    await expect(page.getByLabel("Email")).toBeVisible({ timeout: 2_000 });
  }).toPass({ timeout: 15_000 });
  await page.reload();
  await expect(page.getByLabel("Email")).toBeVisible();
  await expect(page.locator("html")).toHaveAttribute("lang", "en");
});
