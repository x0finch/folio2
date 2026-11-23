import { dismissPasskeyPrompt, gotoHydrated, readLockState, signUpAndLogin } from "./fixtures/app";
import { expect, test } from "./fixtures/test";

// Unit tests can check call arguments, not whether the browser really creates a credential —
// and the lock only unlocks if that credential lives in this device's authenticator.
test.describe("enabling auto-lock", () => {
  test.beforeEach(async ({ page }) => {
    await signUpAndLogin(page);
    await dismissPasskeyPrompt(page);
  });

  test("toggle on → real ceremony → lock on, credential on device", async ({ page, addAuth }) => {
    const authenticator = await addAuth();
    await gotoHydrated(page, "/settings");

    const toggle = page.getByRole("switch", { name: /auto-lock/i });
    await expect(toggle).toHaveAttribute("aria-checked", "false");
    await toggle.click();

    await expect(toggle).toHaveAttribute("aria-checked", "true");
    const state = await readLockState(page);
    expect(state.enabled).not.toBeNull();
    // The stored id must be the authenticator's credential, not just a local flag.
    const creds = await authenticator.credentials();
    expect(creds).toHaveLength(1);
    expect(state.deviceCredential).toBe(creds[0]?.credentialId);
  });

  // Without a UV platform authenticator the browser never fails the ceremony (it waits on a
  // cross-device QR prompt), so the toggle must be disabled up front.
  // Simulated via hasUserVerification: false — setUserVerified(false) means "not pressed yet" and hangs 60s.
  test("no biometrics → toggle disabled with a reason", async ({ page, addAuth }) => {
    const authenticator = await addAuth({
      hasUserVerification: false,
      isUserVerified: false,
    });
    await gotoHydrated(page, "/settings");

    const toggle = page.getByRole("switch", { name: /auto-lock/i });
    await expect(toggle).toBeDisabled();
    await expect(page.getByText(/no fingerprint or face unlock/i)).toBeVisible();

    expect(await authenticator.credentials()).toHaveLength(0);
    const state = await readLockState(page);
    expect(state.enabled).toBeNull();
    expect(state.deviceCredential).toBeNull();
  });

  // Authenticate first, never register: better-auth's excludeCredentials rejects the same authenticator,
  // but only after the platform has already prompted once.
  test("local record lost → verify and reclaim the credential", async ({ page, addAuth }) => {
    const authenticator = await addAuth();
    await gotoHydrated(page, "/settings");

    await page.getByRole("switch", { name: /auto-lock/i }).click();
    await expect(page.getByRole("switch", { name: /auto-lock/i })).toHaveAttribute(
      "aria-checked",
      "true",
    );
    const firstCred = (await authenticator.credentials())[0]?.credentialId;
    expect(firstCred).toBeTruthy();

    // Simulate cleared site data: local record gone, credential still in the authenticator.
    await page.evaluate(() => {
      localStorage.removeItem("folio_lock_device_passkey");
      localStorage.removeItem("folio_lock_enabled");
    });
    await page.reload();

    const verified = page.waitForResponse((r) =>
      r.url().includes("/passkey/verify-authentication"),
    );
    const registerOptions: string[] = [];
    page.on("request", (r) => {
      if (r.url().includes("/passkey/generate-register-options")) registerOptions.push(r.url());
    });

    await page.getByRole("switch", { name: /auto-lock/i }).click();
    await expect(page.getByRole("switch", { name: /auto-lock/i })).toHaveAttribute(
      "aria-checked",
      "true",
    );
    await verified;
    expect(registerOptions).toHaveLength(0);

    expect((await readLockState(page)).deviceCredential).toBe(firstCred);
    expect(await authenticator.credentials()).toHaveLength(1);
  });

  // "User cancels verification" can't be tested here: CDP has no cancel primitive. Unit tests cover it.

  // Re-enabling must prove the person at the keyboard now, not trust a stale localStorage record.
  test("off then on: re-verifies, keeps the chosen timeout", async ({ page, addAuth }) => {
    const authenticator = await addAuth();
    await gotoHydrated(page, "/settings");

    const toggle = page.getByRole("switch", { name: /auto-lock/i });
    await toggle.click();
    await expect(toggle).toHaveAttribute("aria-checked", "true");

    await page.getByRole("tab", { name: "5", exact: true }).click();
    await expect.poll(async () => (await readLockState(page)).timeout).toBe("5");

    await toggle.click();
    await expect(toggle).toHaveAttribute("aria-checked", "false");
    expect((await readLockState(page)).deviceCredential).toBeTruthy();

    const verified = page.waitForResponse((r) =>
      r.url().includes("/passkey/verify-authentication"),
    );
    await toggle.click();
    await expect(toggle).toHaveAttribute("aria-checked", "true");
    await verified;

    const state = await readLockState(page);
    expect(state.timeout).toBe("5");
    expect(await authenticator.credentials()).toHaveLength(1);
  });
});
