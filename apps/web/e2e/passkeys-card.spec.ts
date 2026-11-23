import { dismissPasskeyPrompt, gotoHydrated, readLockState, signUpAndLogin } from "./fixtures/app";
import { type AddAuth, expect, test } from "./fixtures/test";

const autoLockToggle = /auto-lock/i;

// Passkeys card: the two add entry points are deliberately different, plus how deleting interacts with the idle lock.
test.describe("Passkeys card", () => {
  test.beforeEach(async ({ page }) => {
    await signUpAndLogin(page);
    await dismissPasskeyPrompt(page);
  });

  // Case 19: I only want passkey login, no screen lock; the plus button at top right adds one.
  // Case 20: a passkey added via the plus button doesn't switch the lock on.
  test("plus button adds a passkey but doesn't touch the idle lock", async ({ page, addAuth }) => {
    const authenticator = await addAuth();
    await page.goto("/settings");

    await page.getByRole("button", { name: /add passkey/i }).click();
    await expect(page.getByText(/passkey added/i)).toBeVisible();

    expect(await authenticator.credentials()).toHaveLength(1);
    const state = await readLockState(page);
    // This path can't prove "the credential is on this machine" (could be a security key or a phone via QR), so no marker is written.
    expect(state.deviceCredential).toBeNull();
    expect(state.enabled).toBeNull();
    await expect(page.getByRole("switch", { name: autoLockToggle })).toHaveAttribute(
      "aria-checked",
      "false",
    );
  });

  // The plus button deliberately doesn't restrict authenticatorAttachment: it's the app's only entry for hardware security keys.
  test("plus button accepts a hardware security key (USB authenticator)", async ({
    page,
    addAuth,
  }) => {
    const key = await addAuth({ transport: "usb", hasResidentKey: false });
    await page.goto("/settings");

    await page.getByRole("button", { name: /add passkey/i }).click();
    await expect(page.getByText(/passkey added/i)).toBeVisible();
    expect(await key.credentials()).toHaveLength(1);
  });

  // Conversely, with only a USB key plugged in, the idle lock switch is disabled outright: it requires a local authenticator and a USB key can't
  // satisfy it. Capability detection stops this upstream so nobody clicks and then stalls on the system's "use another device" sheet.
  test("with only a USB key the idle lock switch is disabled", async ({ page, addAuth }) => {
    const key = await addAuth({ transport: "usb", hasResidentKey: false });
    await gotoHydrated(page, "/settings");

    await expect(page.getByRole("switch", { name: autoLockToggle })).toBeDisabled();
    await expect(page.getByText(/no fingerprint or face unlock/i)).toBeVisible();
    expect(await key.credentials()).toHaveLength(0);
    expect((await readLockState(page)).enabled).toBeNull();
  });

  // Case 15: the list shows which entry is this machine.
  test("this machine's entry carries the \"This device\" badge, the others don't", async ({
    page,
    addAuth,
  }) => {
    await addTwoRows(page, addAuth);
    // Only this machine's row among the two carries the badge, which is its point (the list can't otherwise tell: passkeys sync across devices and can be renamed).
    await expect(page.getByText(/^this device$/i)).toHaveCount(1);
    await expect(page.getByRole("button", { name: /^remove$/i })).toHaveCount(2);
  });

  // Case 16: I delete this machine's entry; the marker is cleared but the lock stays on: I switched it on myself, the system doesn't revoke
  // it for me, and if it can't be unlocked there's still the sign-out on the lock screen.
  test("delete this machine's entry -> marker cleared and re-registration prompted, lock and timeout untouched", async ({
    page,
    addAuth,
  }) => {
    await addAuth();
    await gotoHydrated(page, "/settings");
    await page.getByRole("switch", { name: autoLockToggle }).click();
    await expect(page.getByRole("switch", { name: autoLockToggle })).toHaveAttribute(
      "aria-checked",
      "true",
    );
    await page.getByRole("tab", { name: "5", exact: true }).click();
    await expect.poll(async () => (await readLockState(page)).timeout).toBe("5");

    await removeRowWithBadge(page);

    await expect.poll(async () => (await readLockState(page)).deviceCredential).toBeNull();
    await expect(page.getByRole("switch", { name: autoLockToggle })).toHaveAttribute(
      "aria-checked",
      "true",
    );
    await expect(page.getByText(/no passkey is registered for this device/i)).toBeVisible();
    const state = await readLockState(page);
    expect(state.enabled).not.toBeNull(); // the lock doesn't switch off with it
    expect(state.timeout).toBe("5"); // timeout is a preference and mustn't be cleared along with it
  });

  // Case 17: I delete another device's entry; the lock stays on. Deleting any entry disabling the lock would make people re-verify for nothing
  // (a duplicate registration is rejected and verification is needed again).
  test("delete another credential -> idle lock unaffected", async ({ page, addAuth }) => {
    await addTwoRows(page, addAuth);
    const before = await readLockState(page);

    await removeRowWithoutBadge(page);

    await expect(page.getByRole("switch", { name: autoLockToggle })).toHaveAttribute(
      "aria-checked",
      "true",
    );
    expect((await readLockState(page)).deviceCredential).toBe(before.deviceCredential);
  });

  // Case 18: I deleted this device's credential on another device; on opening settings the marker is cleared but the lock stays on.
  test("stored credential no longer exists on the server -> settings clears the marker, the lock doesn't switch off", async ({
    page,
    addAuth,
  }) => {
    await addAuth();
    await gotoHydrated(page, "/settings");
    await page.getByRole("switch", { name: autoLockToggle }).click();
    await expect(page.getByRole("switch", { name: autoLockToggle })).toHaveAttribute(
      "aria-checked",
      "true",
    );

    // Simulates "another device deleted it": the local marker points at a credential the server doesn't have. That deletion can't reach
    // this localStorage, so the only way is one comparison when this page loads.
    await page.evaluate(() =>
      localStorage.setItem("folio_lock_device_passkey", "cred-that-no-longer-exists"),
    );
    await page.reload();

    // Wait for the self-correction to land before reading the switch: on first mount useIdleTimeout hasn't read localStorage yet (SSR-safe,
    // always off on the first frame), so asserting the switch first would read an initial, inconclusive false.
    await expect.poll(async () => (await readLockState(page)).deviceCredential).toBeNull();
    // The lock stays on: a stale credential record doesn't mean the user wants the lock gone, and unlocking checks the system keychain, not this marker.
    await expect(page.getByRole("switch", { name: autoLockToggle })).toHaveAttribute(
      "aria-checked",
      "true",
    );
  });

  // Case 21: I have two accounts; on the login page choosing passkey must tell which is which. The system credential picker lives in browser UI
  // Playwright can't see, but its name comes from the server-sent `user.name`, so assert at that layer: it must identify the account, not a device
  // name like "Chrome on macOS" (better-auth's addPasskey({ name }) feeds both, so a device name would make the two accounts look alike).
  // In practice the email is sent, which is naturally unique and tells two accounts apart at a glance.
  test("userName in the registration options identifies the account, not the device", async ({
    page,
    addAuth,
  }) => {
    await addAuth();
    const user = await signUpAndLogin(page);
    await dismissPasskeyPrompt(page);
    await page.goto("/settings");

    const optionsPromise = page.waitForResponse((r) =>
      r.url().includes("/passkey/generate-register-options"),
    );
    await page.getByRole("button", { name: /add passkey/i }).click();
    const body = await (await optionsPromise).json();

    expect(body.user?.name).toBe(user.email);
    expect(body.user?.name).not.toMatch(/chrome|safari|macos|windows|android/i);
    // The device name still lands on the list (so people can tell which machine added it), via the rename-afterwards path.
    await expect(page.getByText(/passkey added/i)).toBeVisible();
    await expect(page.getByText(/chrome|chromium/i).first()).toBeVisible();
  });
});

// Removal is confirmed twice. The row's delete icon and the dialog's confirm button share a name (Remove), so the confirm button is found by
// its destructive variant: the only one styled that way in the dialog.
async function confirmRemoval(page: import("@playwright/test").Page) {
  await expect(page.getByText(/remove passkey\?/i)).toBeVisible();
  await page.locator("button.bg-destructive").click();
  await expect(page.getByText(/passkey removed/i)).toBeVisible();
}

/**
 * Builds "two passkey rows, one of them this machine's".
 * Needs two authenticators: one authenticator holds one credential per account (better-auth registers with excludeCredentials and the browser
 * refuses), so two plus clicks on one authenticator yield one. Order matters: unlock with the platform authenticator first (that row gets the badge),
 * then plug in the USB key for the plus button (the platform one is excluded, so only USB can take this registration).
 */
async function addTwoRows(page: import("@playwright/test").Page, addAuth: AddAuth) {
  await addAuth();
  await gotoHydrated(page, "/settings");

  await page.getByRole("switch", { name: autoLockToggle }).click();
  await expect(page.getByRole("switch", { name: autoLockToggle })).toHaveAttribute(
    "aria-checked",
    "true",
  );

  await addAuth({ transport: "usb", hasResidentKey: false });
  await page.getByRole("button", { name: /add passkey/i }).click();
  await expect(page.getByText(/passkey added/i)).toBeVisible();
  await expect(page.getByRole("button", { name: /^remove$/i })).toHaveCount(2);
}

// A "row" isn't counted by DOM depth: SharedLayoutBg adds an extra z-10 div and depth counting breaks on layout changes. Instead narrow by
// "contains the delete button + has/lacks the badge", then take the deepest, which survives any wrapping.
function rowWithBadge(page: import("@playwright/test").Page) {
  return page
    .locator("div")
    .filter({ has: page.getByRole("button", { name: /^remove$/i }) })
    .filter({ has: page.getByText(/^this device$/i) })
    .last();
}

function rowWithoutBadge(page: import("@playwright/test").Page) {
  return page
    .locator("div")
    .filter({ has: page.getByRole("button", { name: /^remove$/i }) })
    .filter({ hasNotText: /this device/i })
    .last();
}

async function removeRowWithBadge(page: import("@playwright/test").Page) {
  await rowWithBadge(page)
    .getByRole("button", { name: /^remove$/i })
    .click();
  await confirmRemoval(page);
}

async function removeRowWithoutBadge(page: import("@playwright/test").Page) {
  await rowWithoutBadge(page)
    .getByRole("button", { name: /^remove$/i })
    .click();
  await confirmRemoval(page);
}
