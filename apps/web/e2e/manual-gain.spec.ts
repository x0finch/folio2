import { expect, test } from "@playwright/test";
import { dismissPasskeyPrompt, signUpAndLogin } from "./fixtures/app";

// The manual account drawer's Tokens tab is a third render path of `<TokenRowContent>`.
// A dropped prop silently hides the delta row (looks like "feature absent"), and the chain
// server → query → row → drawer → panel → row is too deep for component tests.
// A brand-new account has no 24h-ago baseline, so every delta cell renders `—`.

test.describe("manual account 24h gain", () => {
  test.describe.configure({ timeout: 120_000 });

  test("Tokens row renders the delta (`—`) instead of vanishing", async ({ page }) => {
    await signUpAndLogin(page);
    await dismissPasskeyPrompt(page);
    await page.goto("/accounts");

    // Retry until the modal opens: a click before hydration is silently dropped.
    const scrim = page.getByRole("button", { name: "Close modal" });
    await expect(async () => {
      if ((await scrim.count()) === 0) {
        await page.getByRole("button", { name: /add account/i }).click();
      }
      await expect(page.getByRole("button", { name: /Manual$/i })).toBeVisible({ timeout: 2_000 });
    }).toPass({ timeout: 30_000 });

    await page.getByRole("button", { name: /Manual$/i }).click();

    // The token picker searches upstream; use plain text entry to stay offline.
    await page.getByRole("button", { name: /enter a symbol manually/i }).click();
    await page.locator("#m-token").fill("BTC");
    await page.locator("#m-amount").fill("2");
    await page.locator("#m-price").fill("50000");
    await page.locator("#add-label").fill("E2E Manual");

    // Submit with Enter: during the morph animation the full-screen scrim would catch a click.
    await page.locator("#add-label").press("Enter");
    await expect(scrim).toHaveCount(0, { timeout: 30_000 });

    const row = page.getByRole("button").filter({ hasText: "E2E Manual" });
    await expect(row).toBeVisible({ timeout: 30_000 });
    await row.click();

    // 2 × 50000
    await expect(page.getByText("$100,000.00").first()).toBeVisible({ timeout: 30_000 });

    // Exactly three `—` cells: account list row, drawer header, drawer Tokens row.
    // A dropped prop removes the third, so the count is the bug's exact shape.
    await expect(page.getByText("—", { exact: true })).toHaveCount(3);
  });
});
