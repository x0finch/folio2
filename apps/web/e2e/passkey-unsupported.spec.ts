import { dismissPasskeyPrompt, signUpAndLogin } from "./fixtures/app";
import { expect, test } from "./fixtures/test";

// PublicKeyCredential must be removed before page scripts run, which needs a real addInitScript.
test("browser without passkey support → says so, no add button", async ({ page }) => {
  await signUpAndLogin(page);
  await dismissPasskeyPrompt(page);

  await page.addInitScript(() => {
    // `delete` can't remove the non-configurable native property; the app only checks truthiness.
    Object.defineProperty(window, "PublicKeyCredential", {
      value: undefined,
      configurable: true,
    });
  });
  await page.goto("/settings");

  await expect(page.getByText(/doesn't support passkeys/i)).toBeVisible();
  await expect(page.getByRole("button", { name: /add passkey/i })).toHaveCount(0);
});
