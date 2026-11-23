import { expect, type Page, test } from "@playwright/test";
import { dismissPasskeyPrompt, signUpAndLogin } from "./fixtures/app";

// A hydration mismatch's only symptom is a console error and a re-rendered subtree; the UI ends up
// correct, so only a real server render + client hydration catches it.
// Pitfalls: the user needs holdings (an empty account renders empty on both sides); listen to
// `pageerror`, not just `console` (React reports it as a recoverable error); run two rounds, since
// more pages lose the race once the server cache is warm.

const PAGES = ["/", "/accounts", "/insights"] as const;
const ROUNDS = [1, 2];

// Same account setup as manual-gain.spec.ts, which explains the workarounds.
async function seedHolding(page: Page) {
  await page.goto("/accounts");
  const scrim = page.getByRole("button", { name: "Close modal" });
  await expect(async () => {
    if ((await scrim.count()) === 0) {
      await page.getByRole("button", { name: /add account/i }).click();
    }
    await expect(page.getByRole("button", { name: /Manual$/i })).toBeVisible({ timeout: 2_000 });
  }).toPass({ timeout: 30_000 });
  await page.getByRole("button", { name: /Manual$/i }).click();
  await page.getByRole("button", { name: /enter a symbol manually/i }).click();
  await page.locator("#m-token").fill("BTC");
  await page.locator("#m-amount").fill("2");
  await page.locator("#m-price").fill("50000");
  await page.locator("#add-label").fill("E2E Hydration");
  await page.locator("#add-label").press("Enter");
  await expect(scrim).toHaveCount(0, { timeout: 30_000 });
  await expect(page.getByRole("button").filter({ hasText: "E2E Hydration" })).toBeVisible({
    timeout: 30_000,
  });
}

// The last alternative matches production builds (CI preview), which only emit minified error codes.
const IS_MISMATCH = /Hydration failed|hydration-mismatch|did not match|React error #(418|423|425)/i;

test.describe("first-load hydration", () => {
  test.describe.configure({ timeout: 180_000 });

  test("cold loads of all three pages report no hydration mismatch", async ({ page }) => {
    const hits: string[] = [];
    // `console` too, in case React or Vite changes how the error is delivered.
    page.on("pageerror", (e) => {
      if (IS_MISMATCH.test(e.message)) hits.push(`${page.url()} :: ${e.message.slice(0, 160)}`);
    });
    page.on("console", (m) => {
      if (IS_MISMATCH.test(m.text())) hits.push(`${page.url()} :: ${m.text().slice(0, 160)}`);
    });

    await signUpAndLogin(page);
    await dismissPasskeyPrompt(page);
    await seedHolding(page);
    // Only count from here; account setup isn't under test.
    hits.length = 0;

    for (const _round of ROUNDS) {
      for (const path of PAGES) {
        // Only a full navigation hydrates.
        await page.goto(path);
        // Mismatches come from late-arriving islands; wait for all of them.
        await page.waitForLoadState("networkidle");
      }
    }

    expect(hits).toEqual([]);
  });
});
