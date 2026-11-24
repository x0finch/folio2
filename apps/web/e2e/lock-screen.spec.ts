import {
  dismissPasskeyPrompt,
  gotoHydrated,
  readLockState,
  setLockState,
  signUpAndLogin,
  travelPastIdle,
} from "./fixtures/app";
import type { VirtualAuthenticator } from "./fixtures/authenticator";
import { expect, test } from "./fixtures/test";

// Whole-page behaviour (reload, navigation, real unlock) that component tests can't reach.
test.describe("lock screen", () => {
  let authenticator: VirtualAuthenticator;

  // Every test starts with the lock on and a usable credential on this device.
  test.beforeEach(async ({ page, addAuth }) => {
    await signUpAndLogin(page);
    await dismissPasskeyPrompt(page);
    authenticator = await addAuth();
    await gotoHydrated(page, "/settings");
    await page.getByRole("switch", { name: /auto-lock/i }).click();
    await expect(page.getByRole("switch", { name: /auto-lock/i })).toHaveAttribute(
      "aria-checked",
      "true",
    );
  });

  test("reloading while locked stays locked", async ({ page }) => {
    await page.goto("/");
    await travelPastIdle(page, 15);
    await page.reload();
    await expect(page.getByRole("button", { name: /unlock with passkey/i })).toBeVisible();

    await page.reload();
    await expect(page.getByRole("button", { name: /unlock with passkey/i })).toBeVisible();
  });

  // A password field would let the password manager autofill the unlock for anyone.
  test("lock screen has no password field", async ({ page }) => {
    await page.goto("/");
    await travelPastIdle(page, 15);
    await page.reload();
    await expect(page.getByRole("button", { name: /unlock with passkey/i })).toBeVisible();

    expect(await page.locator('input[type="password"]').count()).toBe(0);
    // A hidden username field would also make password managers treat it as a login form.
    expect(await page.locator('input[autocomplete*="username"]').count()).toBe(0);
  });

  test("passkey unlock → overlay lifts, still on the same page", async ({ page }) => {
    await page.goto("/settings");
    await travelPastIdle(page, 15);
    await page.reload();
    await expect(page.getByRole("button", { name: /unlock with passkey/i })).toBeVisible();

    await page.getByRole("button", { name: /unlock with passkey/i }).click();

    await expect(page.getByRole("button", { name: /unlock with passkey/i })).toHaveCount(0);
    expect(new URL(page.url()).pathname).toBe("/settings");
    await expect(page.getByRole("switch", { name: /auto-lock/i })).toBeVisible();
  });

  // Intentional: locking unmounts children so no content stays in the DOM; local component state
  // (half-filled inputs, scroll) is lost. Query data survives in the outer QueryClient cache.
  test("locking unmounts the page → half-typed input is gone, DOM keeps no content", async ({
    page,
  }) => {
    await page.goto("/settings");
    // Use the inline rename on the passkey row created in beforeEach (named "Chrome on …").
    await page
      .getByRole("button", { name: /chrome|chromium/i })
      .first()
      .click();
    // @folio/ui's Input sets no explicit type, so input[type=text] wouldn't match.
    const input = page.getByRole("textbox").first();
    await input.fill("half-typed text");
    await expect(input).toHaveValue("half-typed text");

    await travelPastIdle(page, 15);
    await page.reload();
    await expect(page.getByRole("button", { name: /unlock with passkey/i })).toBeVisible();
    // The overlay replaces the content rather than covering it.
    await expect(page.getByRole("switch", { name: /auto-lock/i })).toHaveCount(0);

    await page.getByRole("button", { name: /unlock with passkey/i }).click();
    await expect(page.getByRole("switch", { name: /auto-lock/i })).toBeVisible();
    await expect(page.getByRole("textbox")).toHaveCount(0);
    await expect(page.getByText("half-typed text")).toHaveCount(0);
  });

  test("passkey fails → can still sign out from the lock screen", async ({ page }) => {
    await page.goto("/");
    await travelPastIdle(page, 15);
    await page.reload();
    await expect(page.getByRole("button", { name: /unlock with passkey/i })).toBeVisible();

    await authenticator.setUserVerified(false);
    await page.getByRole("button", { name: /unlock with passkey/i }).click();
    await expect(page.getByRole("button", { name: /sign out/i })).toBeVisible();

    await page.getByRole("button", { name: /sign out/i }).click();
    await expect(page).toHaveURL(/\/login/);
  });

  // Without clearIdleLockState, the stale locked flag would relock right after signing back in.
  test("sign out from the lock screen, sign in again → not relocked", async ({ page }) => {
    await page.goto("/");
    await travelPastIdle(page, 15);
    await page.reload();
    await expect(page.getByRole("button", { name: /unlock with passkey/i })).toBeVisible();

    // Fixture quirk: /login fires conditional-UI passkey autofill on mount, and the virtual
    // authenticator's automaticPresenceSimulation answers it, signing straight back in within ~200ms.
    await authenticator.clearCredentials();
    await page.getByRole("button", { name: /sign out/i }).click();
    await expect(page).toHaveURL(/\/login/);
    expect((await readLockState(page)).locked).toBeNull();

    const user = await signUpAndLogin(page);
    expect(user.email).toBeTruthy();
    await page.goto("/");
    await expect(page.getByRole("button", { name: /unlock with passkey/i })).toHaveCount(0);
  });

  test("1-minute timeout → locks after 1 minute, not before", async ({ page }) => {
    // A pre-hydration click is swallowed and the poll below won't retry it.
    await gotoHydrated(page, "/settings");
    await page.getByRole("tab", { name: "1", exact: true }).click();
    await expect.poll(async () => (await readLockState(page)).timeout).toBe("1");

    await page.evaluate(() =>
      localStorage.setItem("folio_lock_last_active", String(Date.now() - 30_000)),
    );
    await page.reload();
    await expect(page.getByRole("switch", { name: /auto-lock/i })).toBeVisible();
    await expect(page.getByRole("button", { name: /unlock with passkey/i })).toHaveCount(0);

    await travelPastIdle(page, 1);
    await page.reload();
    await expect(page.getByRole("button", { name: /unlock with passkey/i })).toBeVisible();
  });

  // Still lock: a missing record usually means cleared site data, exactly when someone else may be
  // at the machine. Sign-out remains the way out.
  test("no credential record → still locks, sign-out available", async ({ page }) => {
    await page.goto("/");
    await setLockState(page, { enabled: true, deviceCredential: null });
    await travelPastIdle(page, 15);
    await page.reload();

    await expect(page.getByRole("button", { name: /unlock with passkey/i })).toBeVisible();
    await expect(page.getByRole("button", { name: /sign out/i })).toBeVisible();
    await expect(page.getByText(/no passkey is registered for this device/i)).toBeVisible();
  });

  // The previous case must not loop: sign out → password sign-in → content, not the lock again.
  test("locked without a credential → password sign-in gets through", async ({ page }) => {
    const email = await page.evaluate(async () => {
      const res = await fetch("/api/auth/get-session", { credentials: "include" });
      return ((await res.json()) as { user?: { email?: string } } | null)?.user?.email ?? "";
    });
    expect(email).toBeTruthy();

    await page.goto("/");
    await setLockState(page, { enabled: true, deviceCredential: null });
    await travelPastIdle(page, 15);
    await page.reload();
    await expect(page.getByRole("button", { name: /unlock with passkey/i })).toBeVisible();

    // Same autofill quirk as above; `deviceCredential: null` only cleared localStorage.
    await authenticator.clearCredentials();
    await page.getByRole("button", { name: /sign out/i }).click();
    await expect(page).toHaveURL(/\/login/);
    // The client-side sign-out remounts the form after landing ("element was detached").
    await gotoHydrated(page, "/login");
    await page.getByLabel(/email/i).fill(email);
    // Submit with Enter: the Sign in button shifts and is replaced when the passkey button appears.
    await page.getByLabel(/password/i).fill("e2e-password-1234");
    await page.getByLabel(/password/i).press("Enter");

    await expect(page).toHaveURL(/^[^?]*\/(\?.*)?$/);
    await expect(page.getByRole("button", { name: /unlock with passkey/i })).toHaveCount(0);
  });

  test("enabled but no credential record → toggle stays on, prompts to re-register", async ({
    page,
  }) => {
    await page.goto("/settings");
    await setLockState(page, { enabled: true, deviceCredential: null });
    await page.reload();

    await expect(page.getByRole("switch", { name: /auto-lock/i })).toHaveAttribute(
      "aria-checked",
      "true",
    );
    await expect(page.getByText(/no passkey is registered for this device/i)).toBeVisible();
  });
});
