import { dismissPasskeyPrompt, signUpAndLogin } from "./fixtures/app";
import { expect, test } from "./fixtures/test";

// 用例 24:浏览器不支持 passkey 时,设置页明说不支持,不给一个开不了的开关。
//
// 这条只有 E2E 做得干净:要在**页面脚本跑起来之前**把 window.PublicKeyCredential 抹掉,jsdom 里
// 那是 stub 一个全局,真浏览器里得靠 addInitScript。
test("浏览器不支持 passkey → 明说不支持,不给加号", async ({ page }) => {
  await signUpAndLogin(page);
  await dismissPasskeyPrompt(page);

  await page.addInitScript(() => {
    // 用 defineProperty 而不是 delete:PublicKeyCredential 是 window 上不可配置的原生属性,delete
    // 在真浏览器里根本删不掉(jsdom 那种宽松环境才行)。应用侧判的是 `!window.PublicKeyCredential`,
    // 所以置 undefined 就够。
    Object.defineProperty(window, "PublicKeyCredential", {
      value: undefined,
      configurable: true,
    });
  });
  await page.goto("/settings");

  await expect(page.getByText(/doesn't support passkeys/i)).toBeVisible();
  await expect(page.getByRole("button", { name: /add passkey/i })).toHaveCount(0);
});
