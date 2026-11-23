import { expect, test } from "@playwright/test";

// The static HTML is English; a non-English first frame relies on the inline <head> script picking
// copy by `<html lang>`. Aborting module scripts freezes the page at that pre-hydration frame.

const IS_MISMATCH = /Hydration failed|hydration-mismatch|did not match|React error #(418|423|425)/i;

test.describe("Chinese selected", () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => localStorage.setItem("folio_locale", "zh"));
  });

  test("<html lang> and the splash line are Chinese before hydration", async ({ page }) => {
    await page.route(/\/assets\/.+\.js$/, (route) => route.abort());
    await page.goto("/login");
    await expect(page.locator("html")).toHaveAttribute("lang", "zh");
    // Both languages are in the DOM; innerText skips the display:none one.
    await expect(page.locator("#folio-splash-msg")).toHaveText("准备中…", { useInnerText: true });
  });

  test("UI is Chinese after hydration, no hydration errors", async ({ page }) => {
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

test("switching to English on login survives a reload", async ({ page }) => {
  await page.goto("/login");
  await page.evaluate(() => localStorage.setItem("folio_locale", "zh"));
  await page.reload();
  await expect(page.getByLabel("邮箱")).toBeVisible();
  // Clicks before hydration are silently dropped; retry until one lands.
  await expect(async () => {
    await page.getByRole("button", { name: "EN", exact: true }).click();
    await expect(page.getByLabel("Email")).toBeVisible({ timeout: 2_000 });
  }).toPass({ timeout: 15_000 });
  await page.reload();
  await expect(page.getByLabel("Email")).toBeVisible();
  await expect(page.locator("html")).toHaveAttribute("lang", "en");
});
