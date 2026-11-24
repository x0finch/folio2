import { expect, test } from "@playwright/test";
import { dismissPasskeyPrompt, signUpAndLogin } from "./fixtures/app";
import { accountIdByLabel, addBinanceAccount, waitForSnapshot } from "./fixtures/sync";

// Horizontal overflow emerges from layout, so only a real browser can measure it.
// Measured with data present: long symbols and big numbers in holding rows are what push the width.
test.describe("narrow phone: home does not overflow horizontally", () => {
  test.describe.configure({ timeout: 120_000 });
  // iPhone 12/13/14 logical width in CSS px.
  test.use({ viewport: { width: 390, height: 844 } });

  test("after syncing data, home fits a 390px viewport", async ({ page }) => {
    await signUpAndLogin(page);
    await dismissPasskeyPrompt(page);
    await page.goto("/accounts");
    // Let the background sync run: the snapshot is what puts holding rows on the page.
    await addBinanceAccount(page, "E2E Mobile");
    const id = await accountIdByLabel(page, "E2E Mobile");
    await waitForSnapshot(
      page,
      id,
      (s) => s.balances.length > 0,
      "sync wrote no snapshot; cannot measure the populated layout",
    );

    await page.goto("/");
    // Measure the final layout, not the pending skeleton.
    await expect(page.getByText("Syncing…")).toHaveCount(0, { timeout: 30_000 });

    const { scrollWidth, clientWidth } = await page.evaluate(() => {
      const el = document.documentElement;
      return { scrollWidth: el.scrollWidth, clientWidth: el.clientWidth };
    });
    expect(scrollWidth, `home overflows by ${scrollWidth - clientWidth}px`).toBeLessThanOrEqual(
      clientWidth,
    );
  });
});
