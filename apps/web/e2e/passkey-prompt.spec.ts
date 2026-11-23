import { dismissPasskeyPrompt, enableLock, lockNow, signUpAndLogin } from "./fixtures/app";
import { expect, test } from "./fixtures/test";

// Settings sign-out asks for confirmation (the lock screen's doesn't); the confirm button shares
// the trigger's name, so match the destructive variant.
async function signOutFromSettings(page: import("@playwright/test").Page) {
  await page.getByRole("button", { name: /sign out/i }).click();
  await page.locator("button.bg-destructive").click();
  await expect(page).toHaveURL(/\/login/);
}

// Two of the prompt's three conditions come from localStorage and the network.
test.describe("passkey prompt", () => {
  // Sign up through the UI: the prompt hangs off the form's success path.
  async function signUpThroughForm(page: import("@playwright/test").Page) {
    const suffix = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
    await page.goto("/login");
    // A pre-hydration tab click is silently dropped, so retry until the tab switches (idempotent).
    // No client-only request to wait on: one test removes PublicKeyCredential, so autofill never fires.
    await expect(async () => {
      await page.getByRole("tab", { name: /sign up/i }).click();
      await expect(page.getByRole("button", { name: /^sign up$/i })).toBeVisible({ timeout: 500 });
    }).toPass();
    await page.getByLabel(/email/i).fill(`e2e-${suffix}@folio.test`);
    await page.getByLabel(/password/i).fill("e2e-password-1234");
    await page.getByLabel(/password/i).press("Enter");
  }

  // Submit with Enter: the Sign in button shifts and is replaced once the passkey button appears.
  async function signInThroughForm(page: import("@playwright/test").Page, email: string) {
    await page.getByLabel(/email/i).fill(email);
    await page.getByLabel(/password/i).fill("e2e-password-1234");
    await page.getByLabel(/password/i).press("Enter");
  }

  test("first sign-up on a capable device → prompt shown", async ({ page, addAuth }) => {
    await addAuth();
    await signUpThroughForm(page);
    await expect(page.getByText(/sign in faster next time/i)).toBeVisible();
  });

  test("device without passkey support → no prompt, straight to home", async ({ page }) => {
    await page.addInitScript(() => {
      Object.defineProperty(window, "PublicKeyCredential", {
        value: undefined,
        configurable: true,
      });
    });
    await signUpThroughForm(page);

    await expect(page).toHaveURL(/^[^?]*\/(\?.*)?$/);
    await expect(page.getByText(/sign in faster next time/i)).toHaveCount(0);
  });

  test("account already has a passkey → no prompt on next sign-in", async ({ page, addAuth }) => {
    await addAuth();
    // enableLock registers a real passkey.
    await enableLock(page);
    const email = await page.evaluate(async () => {
      const res = await fetch("/api/auth/get-session", { credentials: "include" });
      const session = (await res.json()) as { user?: { email?: string } } | null;
      return session?.user?.email ?? "";
    });
    expect(email).toBeTruthy();

    // Clear "don't ask again" so only the "has a passkey" condition remains.
    await page.evaluate(() => localStorage.removeItem("folio_passkey_prompt_dismissed"));
    await signOutFromSettings(page);

    await signInThroughForm(page, email);

    await expect(page).toHaveURL(/^[^?]*\/(\?.*)?$/);
    await expect(page.getByText(/sign in faster next time/i)).toHaveCount(0);
  });

  test("“don't ask again” → this device is not asked again", async ({ page, addAuth }) => {
    await addAuth();
    await signUpThroughForm(page);
    await expect(page.getByText(/sign in faster next time/i)).toBeVisible();
    await page.getByRole("button", { name: /don't ask again/i }).click();
    await expect(page).toHaveURL(/^[^?]*\/(\?.*)?$/);

    // Dismissal is per device (localStorage), since passkeys are registered per device.
    await signUpThroughForm(page);
    await expect(page.getByText(/sign in faster next time/i)).toHaveCount(0);
  });
});

test.describe("session expiry and the lock screen", () => {
  test("locked long enough for the session to expire → passkey still gets in", async ({
    page,
    addAuth,
  }) => {
    await addAuth();
    await enableLock(page);
    await page.goto("/settings");
    await lockNow(page);

    // Simulate an expired session.
    const cookies = await page.context().cookies();
    await page.context().clearCookies();
    expect(cookies.length).toBeGreaterThan(0);

    // signIn.passkey recreates the session, so unlocking must not fall back to the password form.
    await page.getByRole("button", { name: /unlock with passkey/i }).click();
    await expect(page.getByRole("switch", { name: /auto-lock/i })).toBeVisible();
    expect(new URL(page.url()).pathname).toBe("/settings");
  });

  test("signed-out visitor on a locked machine → login page, not the lock", async ({ page }) => {
    await signUpAndLogin(page);
    await dismissPasskeyPrompt(page);
    await page.goto("/settings");
    await signOutFromSettings(page);

    // Sign-out clears lock state; even if planted back, the lock only covers the authed area.
    await page.evaluate(() => {
      localStorage.setItem("folio_lock_enabled", "1");
      localStorage.setItem("folio_lock_locked", String(Date.now()));
      localStorage.setItem("folio_lock_device_passkey", "stale-credential");
    });
    await page.goto("/");
    await expect(page).toHaveURL(/\/login/);
    await expect(page.getByRole("button", { name: /unlock with passkey/i })).toHaveCount(0);
  });
});
