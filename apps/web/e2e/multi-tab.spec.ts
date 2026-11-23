import {
  dismissPasskeyPrompt,
  enableLock,
  gotoHydrated,
  KEYS,
  lockNow,
  readLockState,
  signUpAndLogin,
} from "./fixtures/app";
import { expect, test } from "./fixtures/test";

/** Per-user record keys (`user:<id>`) in the query-cache IndexedDB store. */
const persistedUserKeys = (page: import("@playwright/test").Page) =>
  page.evaluate(
    () =>
      new Promise<string[]>((resolve, reject) => {
        const open = indexedDB.open("folio-query-cache");
        open.onupgradeneeded = () => open.result.createObjectStore("clients");
        open.onerror = () => reject(open.error);
        open.onsuccess = () => {
          const db = open.result;
          const all = db.transaction("clients").objectStore("clients").getAllKeys();
          all.onsuccess = () => {
            db.close();
            resolve(all.result.map(String).filter((k) => k.startsWith("user:")));
          };
          all.onerror = () => reject(all.error);
        };
      }),
  );

// Pages in one browser context share cookies and localStorage, and storage events cross pages,
// so cross-tab sync is exercised for real here.
test.describe("multiple tabs", () => {
  test("one tab locks → the other tab locks too", async ({ page, addAuth }) => {
    await addAuth();
    await enableLock(page);

    const other = await page.context().newPage();
    await gotoHydrated(other, "/settings");
    await expect(other.getByRole("switch", { name: /auto-lock/i })).toBeVisible();

    await page.goto("/");
    await lockNow(page);

    // Otherwise switching tabs would be a bypass; the other tab learns via the storage event.
    await expect(other.getByRole("button", { name: /unlock with passkey/i })).toBeVisible();
    await other.close();
  });

  test("opening a new tab while locked → also locked", async ({ page, addAuth }) => {
    await addAuth();
    await enableLock(page);
    await page.goto("/");
    await lockNow(page);

    // A fresh tab compares the timestamp on mount rather than trusting "just opened".
    const fresh = await page.context().newPage();
    await fresh.goto("/");
    await expect(fresh.getByRole("button", { name: /unlock with passkey/i })).toBeVisible();
    await fresh.close();
  });

  // Deliberately asymmetric: locking syncs across tabs, unlocking doesn't — each locked tab needs
  // its own proof of presence. Don't "fix" this.
  test("unlocking one tab → the other stays locked (by design)", async ({ page, addAuth }) => {
    await addAuth();
    await enableLock(page);

    const other = await page.context().newPage();
    await other.goto("/settings");

    await page.goto("/settings");
    await lockNow(page);
    await expect(other.getByRole("button", { name: /unlock with passkey/i })).toBeVisible();

    await page.getByRole("button", { name: /unlock with passkey/i }).click();
    await expect(page.getByRole("switch", { name: /auto-lock/i })).toBeVisible();

    await expect(other.getByRole("button", { name: /unlock with passkey/i })).toBeVisible();
    // The shared flag is cleared; the other tab simply hasn't verified yet.
    expect((await readLockState(other)).locked).toBeNull();

    // Can't verify the other tab unlocking itself: the CDP virtual authenticator is bound to one page.
    await other.close();
  });

  test("locked, sign out in another tab → not stuck on the lock", async ({ page, addAuth }) => {
    const auth = await addAuth();
    await enableLock(page);
    await page.goto("/");
    await lockNow(page);

    const other = await page.context().newPage();
    await other.goto("/settings");
    // Wait for the lock screen first: settings has its own "Sign out" button that asks for confirmation.
    await expect(other.getByRole("button", { name: /unlock with passkey/i })).toBeVisible();
    // The virtual authenticator would auto-answer /login's conditional-UI autofill and sign back in.
    await auth.clearCredentials();
    await other.getByRole("button", { name: /sign out/i }).click();
    await expect(other).toHaveURL(/\/login/);

    // Either the route guard redirects to /login, or the lock screen still shows and its sign-out works.
    await page.reload();
    await expect(async () => {
      if (!page.url().includes("/login")) {
        const signOut = page.getByRole("button", { name: /sign out/i });
        if (await signOut.count()) await signOut.first().click();
      }
      expect(page.url()).toMatch(/\/login/);
    }).toPass();
    await other.close();
  });

  // Another tab still holds the data; a refetch-triggered cache event must not persist it after sign-out.
  test("sign out in one tab → the other stops persisting the cache", async ({ page }) => {
    await signUpAndLogin(page);
    await dismissPasskeyPrompt(page);
    const other = await page.context().newPage();
    await gotoHydrated(other, "/settings");
    await gotoHydrated(page, "/settings");
    await expect.poll(() => persistedUserKeys(page)).toHaveLength(1);

    await page.getByRole("button", { name: /sign out/i }).click();
    await page.locator("button.bg-destructive").click();
    await expect(page).toHaveURL(/\/login/);

    // Persistence is throttled to 1s, so wait one extra window after the redirect.
    // Hang the requests: a failed refetch carries an uncloneable redirect, so the write would fail by
    // coincidence rather than by the guard.
    await other.route("**/_serverFn/**", () => {});
    await other.bringToFront();
    // react-query listens on window, and a synthetic event doesn't bubble there.
    await other.evaluate(() => window.dispatchEvent(new Event("visibilitychange")));
    await expect(other).toHaveURL(/\/login/);
    await other.waitForTimeout(1_500);
    expect(await persistedUserKeys(other)).toEqual([]);
    expect(await persistedUserKeys(page)).toEqual([]);
    await other.close();
  });

  test("one tab has the lock, the other deletes its credential → record cleared, lock kept", async ({
    page,
    addAuth,
  }) => {
    await addAuth();
    await enableLock(page);
    const before = await readLockState(page);
    expect(before.deviceCredential).toBeTruthy();

    const other = await page.context().newPage();
    await other.goto("/settings");
    await other
      .locator("div")
      .filter({ has: other.getByRole("button", { name: /^remove$/i }) })
      .filter({ has: other.getByText(/^this device$/i) })
      .last()
      .getByRole("button", { name: /^remove$/i })
      .click();
    await expect(other.getByText(/remove passkey\?/i)).toBeVisible();
    await other.locator("button.bg-destructive").click();
    await expect(other.getByText(/passkey removed/i)).toBeVisible();

    await expect.poll(async () => (await readLockState(other)).deviceCredential).toBeNull();

    // Deleting a credential is not disabling the lock; unlock goes through the OS keychain anyway.
    await page.reload();
    await expect(page.getByRole("switch", { name: /auto-lock/i })).toHaveAttribute(
      "aria-checked",
      "true",
    );
    await expect(page.getByText(/no passkey is registered for this device/i)).toBeVisible();
    await other.close();
  });
});

test.describe("fast hands, slow network", () => {
  test("double-clicking the toggle → one ceremony, one credential", async ({ page, addAuth }) => {
    const authenticator = await addAuth();
    await page.goto("/login");
    await dismissPasskeyPrompt(page);
    const { signUpAndLogin } = await import("./fixtures/app");
    await signUpAndLogin(page);
    await dismissPasskeyPrompt(page);
    await gotoHydrated(page, "/settings");

    const toggle = page.getByRole("switch", { name: /auto-lock/i });
    // No wait between clicks: the second hits either the disabled state or the pre-busy window.
    await toggle.click();
    await toggle.click({ force: true, noWaitAfter: true }).catch(() => {});

    await expect(toggle).toHaveAttribute("aria-checked", "true");
    expect(await authenticator.credentials()).toHaveLength(1);
  });

  test("verified but list refresh fails → toggle and record agree", async ({ page, addAuth }) => {
    await addAuth();
    await enableLock(page);
    const enabled = await readLockState(page);

    const toggle = page.getByRole("switch", { name: /auto-lock/i });
    await toggle.click();
    await expect(toggle).toHaveAttribute("aria-checked", "false");

    await page.route("**/passkey/list-user-passkeys", (route) => route.abort("failed"));
    // Wait on events that must happen: the fallback to register sends generate-register-options
    // (not verify-registration — excludeCredentials rejects this authenticator first), and the
    // toggle re-enables when the flow's finally runs.
    const registerStarted = page.waitForResponse((r) =>
      r.url().includes("passkey/generate-register-options"),
    );
    await toggle.click();
    await registerStarted;
    await expect(toggle).toBeEnabled();

    // Never "switch on but no credential record": that shows protection that isn't there.
    const after = await readLockState(page);
    const switchOn = await toggle.getAttribute("aria-checked");
    if (switchOn === "true") {
      expect(after.deviceCredential).toBeTruthy();
    } else {
      expect(after.enabled).toBeNull();
    }
    expect(after.deviceCredential ?? enabled.deviceCredential).toBeTruthy();
    await page.unroute("**/passkey/list-user-passkeys");
  });
});

test.describe("local record corrupted or unwritable", () => {
  test("localStorage unwritable → no crash, no false success", async ({ page, addAuth }) => {
    await addAuth();
    const { signUpAndLogin } = await import("./fixtures/app");
    await signUpAndLogin(page);
    await dismissPasskeyPrompt(page);

    // setItem throws (private mode / quota exceeded) while reads still work.
    await page.addInitScript(() => {
      const proto = Object.getPrototypeOf(localStorage);
      proto.setItem = () => {
        throw new DOMException("QuotaExceededError");
      };
    });
    await gotoHydrated(page, "/settings");

    const toggle = page.getByRole("switch", { name: /auto-lock/i });
    const registerStarted = page.waitForResponse((r) =>
      r.url().includes("passkey/generate-register-options"),
    );
    await toggle.click();
    await registerStarted;
    await expect(toggle).toBeEnabled();

    // An unpersisted lock would be gone next visit, so don't report it as on.
    await expect(page.getByRole("switch", { name: /auto-lock/i })).toBeVisible();
    await expect(toggle).toHaveAttribute("aria-checked", "false");
  });

  test("local record points at another real credential → kept, badge on the wrong row", async ({
    page,
    addAuth,
  }) => {
    await addAuth();
    await enableLock(page);

    // Add a second passkey from a USB key so there are two rows.
    const usb = await addAuth({ transport: "usb", hasResidentKey: false });
    await page.getByRole("button", { name: /add passkey/i }).click();
    await expect(page.getByText(/passkey added/i)).toBeVisible();
    const usbCred = (await usb.credentials())[0]?.credentialId;
    expect(usbCred).toBeTruthy();

    await page.evaluate(({ keys, id }) => localStorage.setItem(keys.deviceCredential, id), {
      keys: KEYS,
      id: usbCred as string,
    });
    await page.reload();

    // Self-repair only checks the credential still exists on the account, so the badge is wrong.
    // Display-only: unlock uses the OS credential picker, not this record.
    expect((await readLockState(page)).deviceCredential).toBe(usbCred);
    await expect(page.getByText(/^this device$/i)).toHaveCount(1);

    await page.goto("/");
    await lockNow(page);
    await page.getByRole("button", { name: /unlock with passkey/i }).click();
    await expect(page.getByRole("button", { name: /unlock with passkey/i })).toHaveCount(0);
  });
});
