import { expect, test } from "@playwright/test";
import { dismissPasskeyPrompt, signUpAndLogin } from "./fixtures/app";
import { addBinanceAccount, blockPostCreateSync } from "./fixtures/sync";

// `pending` crosses server fn → select → component; dropping it anywhere silently renders "$0".
// Blocking the post-create sync leaves zero snapshots, so the page stays pending deterministically.
test.describe("home: first-sync loading state", () => {
  test.describe.configure({ timeout: 120_000 });

  test("accounts but no snapshots yet → hero shows Syncing… instead of $0", async ({ page }) => {
    await signUpAndLogin(page);
    await dismissPasskeyPrompt(page);
    await blockPostCreateSync(page);
    await page.goto("/accounts");
    await addBinanceAccount(page, "E2E FirstSync");

    await page.goto("/");

    // This label only renders on the pending branch; `.first()` guards against a strict-mode duplicate.
    await expect(page.getByText("Syncing…").first()).toBeVisible({ timeout: 30_000 });
  });
});
