import { enableLock, KEYS, lockNow, readLockState } from "./fixtures/app";
import { expect, test } from "./fixtures/test";

// The lock only guards the client DOM (threat model: casual snooping, not a lost device).
// Two kinds of tests: paths an ordinary user can reach (must be blocked), and accepted bypasses
// that pin the current limits so nobody mistakes them for protection.
test.describe("attempts to bypass the lock screen", () => {
  test.beforeEach(async ({ page, addAuth }) => {
    await addAuth();
    await enableLock(page);
  });

  test("navigating to another page while locked → still locked", async ({ page }) => {
    await page.goto("/");
    await lockNow(page);

    // The lock covers the whole authed area, not a single page.
    await page.goto("/accounts");
    await expect(page.getByRole("button", { name: /unlock with passkey/i })).toBeVisible();
    await page.goto("/insights");
    await expect(page.getByRole("button", { name: /unlock with passkey/i })).toBeVisible();
  });

  test("going back while locked → still locked", async ({ page }) => {
    await page.goto("/");
    await page.goto("/settings");
    await lockNow(page);

    await page.goBack();
    // A bfcache-restored page re-checks the timestamp.
    await expect(page.getByRole("button", { name: /unlock with passkey/i })).toBeVisible();
  });

  // Print lays out the whole document under the fixed overlay; children are unmounted, so nothing leaks.
  test("printing while locked → prints the lock screen, not holdings", async ({ page }) => {
    await page.goto("/settings");
    await lockNow(page);

    await page.emulateMedia({ media: "print" });
    await expect(page.getByRole("button", { name: /unlock with passkey/i })).toBeVisible();
    await expect(page.getByRole("switch", { name: /auto-lock/i })).toHaveCount(0);
    await expect(page.getByText(/provider api keys/i)).toHaveCount(0);
    await page.emulateMedia({ media: null });
  });

  test("Tab while locked → focus cannot reach under the overlay", async ({ page }) => {
    await page.goto("/settings");
    await lockNow(page);

    for (let i = 0; i < 8; i++) await page.keyboard.press("Tab");

    // The page below is unmounted, so the real check is that its controls don't exist.
    const focusedText = await page.evaluate(
      () => (document.activeElement as HTMLElement | null)?.innerText ?? "",
    );
    expect(focusedText).not.toMatch(/sign out this device|provider|valuation/i);
    await expect(page.getByRole("switch", { name: /auto-lock/i })).toHaveCount(0);
  });

  test("background scroll is locked while locked", async ({ page }) => {
    await page.goto("/settings");
    await lockNow(page);

    // Both html and body need overflow:hidden, or the wheel scroll-chains into the app below.
    const overflow = await page.evaluate(() => ({
      root: getComputedStyle(document.documentElement).overflow,
      body: getComputedStyle(document.body).overflow,
    }));
    expect(overflow.root).toBe("hidden");
    expect(overflow.body).toBe("hidden");
  });

  // Accepted bypasses below: these assert current behaviour. Changing them changes the threat model.

  test("clearing only the locked flag is not enough → mount re-checks and relocks", async ({
    page,
  }) => {
    await page.goto("/settings");
    await lockNow(page);

    await page.evaluate((keys) => localStorage.removeItem(keys.locked), KEYS);
    await page.reload();

    // The cross-tab flag is only half of it; the last-active timestamp decides.
    await expect(page.getByRole("button", { name: /unlock with passkey/i })).toBeVisible();
  });

  test("clearing all local lock state bypasses it (accepted trade-off)", async ({ page }) => {
    await page.goto("/settings");
    await lockNow(page);

    await page.evaluate((keys) => {
      localStorage.removeItem(keys.locked);
      localStorage.removeItem(keys.lastActive);
    }, KEYS);
    await page.reload();

    // Bypassed: closing this needs a server-side lock.
    await expect(page.getByRole("switch", { name: /auto-lock/i })).toBeVisible();
    await expect(page.getByRole("button", { name: /unlock with passkey/i })).toHaveCount(0);
  });

  test("last-active in the future → no lock (clock skew errs on not locking)", async ({ page }) => {
    await page.goto("/settings");
    await page.evaluate(
      (keys) => localStorage.setItem(keys.lastActive, String(Date.now() + 60 * 60_000)),
      KEYS,
    );
    await page.reload();

    // shouldLock skips when now < lastActiveAt so clock skew never locks spuriously; known bypass.
    await expect(page.getByRole("button", { name: /unlock with passkey/i })).toHaveCount(0);
    expect((await readLockState(page)).locked).toBeNull();
  });

  test("API calls while locked still return data (no server-side lock)", async ({ page }) => {
    await page.goto("/settings");
    await lockNow(page);

    // The client lock leaves the session intact; unlocking is not a re-login.
    const status = await page.evaluate(async () => {
      const res = await fetch("/api/export", { credentials: "include" });
      return res.status;
    });
    expect(status).toBe(200);
  });
});

test.describe("when signed out", () => {
  test("visiting home signed out → login page, no lock screen", async ({ page }) => {
    // Lock state left by a previous user must not lock the login page.
    await page.goto("/login");
    await page.evaluate((keys) => {
      localStorage.setItem(keys.enabled, "1");
      localStorage.setItem(keys.deviceCredential, "someones-old-credential");
      localStorage.setItem(keys.locked, "1");
    }, KEYS);

    await page.goto("/");
    await expect(page).toHaveURL(/\/login/);
    await expect(page.getByRole("button", { name: /unlock with passkey/i })).toHaveCount(0);
  });
});
