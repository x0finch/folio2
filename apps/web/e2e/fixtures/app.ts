import { expect, type Page } from "@playwright/test";

// All idle-lock state lives in these localStorage keys (single source: src/lib/idle-lock.ts and hooks/use-idle-lock.ts). Tests read and write
// them directly instead of clicking the switch each time: how it gets enabled is the subject of other tests and would only blur failure causes.
export const KEYS = {
  timeout: "folio_lock_timeout",
  enabled: "folio_lock_enabled",
  deviceCredential: "folio_lock_device_passkey",
  lastActive: "folio_lock_last_active",
  locked: "folio_lock_locked",
  promptDismissed: "folio_passkey_prompt_dismissed",
} as const;

export interface TestUser {
  email: string;
  password: string;
  name: string;
}

/**
 * Navigates to a page and returns only once the client is really alive.
 * CI runs the build output and the page paints very fast: when `goto` returns the DOM exists but React may not have attached handlers, so a click is
 * silently swallowed (no error, no effect) and the test fails several lines later, far from the cause (seen in CI about 1 in 40).
 * It waits for something that should appear rather than a duration: every page has a request only the client can send (the login page's passkey
 * conditional-UI autofill, the settings page's passkey list). Not `networkidle`: it adds a 500ms quiet wait, a pure loss over dozens of navigations.
 */
const HYDRATION_PROBE = {
  "/login": "passkey/generate-authenticate-options",
  "/settings": "passkey/list-user-passkeys",
} as const;

export async function gotoHydrated(page: Page, path: keyof typeof HYDRATION_PROBE) {
  // `waitUntil: "commit"` returns as soon as the new document starts loading (JS hasn't run); the listener must attach after that: attached before goto,
  // the same request just sent by the previous page would satisfy `waitForResponse` at once and "client alive" would be false, so form values get wiped by
  // the later hydrated controlled state (2 of 4 runs: the email field cleared itself 200ms after filling and Enter was blocked by `required`).
  // Waiting for load before attaching also fails: the client may have already sent the request and the listener waits until timeout.
  await page.goto(path, { waitUntil: "commit" });
  await page.waitForResponse((r) => r.url().includes(HYDRATION_PROBE[path]));
}

/**
 * Creates a test user and logs in (better-auth has autoSignIn, so signing up yields a session cookie).
 * Goes over HTTP, not the UI: the login form has its own tests; this just needs a logged-in starting point. The email is random each time, so repeated runs on
 * one local D1 don't hit the unique constraint.
 */
export async function signUpAndLogin(page: Page, overrides: Partial<TestUser> = {}) {
  const suffix = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
  const user: TestUser = {
    email: overrides.email ?? `e2e-${suffix}@folio.test`,
    password: overrides.password ?? "e2e-password-1234",
    name: overrides.name ?? `E2E ${suffix}`,
  };

  // Must land on a same-origin page first so fetch carries the right Origin (better-auth has a CSRF check).
  await page.goto("/login");
  const status = await page.evaluate(async (u) => {
    const res = await fetch("/api/auth/sign-up/email", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: u.email, password: u.password, name: u.name }),
    });
    return { ok: res.ok, status: res.status, body: res.ok ? "" : await res.text() };
  }, user);
  expect(status.ok, `sign-up failed: ${status.status} ${status.body}`).toBe(true);

  return user;
}

/** Writes lock state directly, skipping the "switch it on first" preamble. */
export async function setLockState(
  page: Page,
  state: { enabled?: boolean; timeoutMinutes?: number; deviceCredential?: string | null },
) {
  await page.evaluate(
    ({ keys, state }) => {
      if (state.enabled === true) localStorage.setItem(keys.enabled, "1");
      if (state.enabled === false) localStorage.removeItem(keys.enabled);
      if (state.timeoutMinutes != null)
        localStorage.setItem(keys.timeout, String(state.timeoutMinutes));
      if (state.deviceCredential === null) localStorage.removeItem(keys.deviceCredential);
      else if (state.deviceCredential != null)
        localStorage.setItem(keys.deviceCredential, state.deviceCredential);
    },
    { keys: KEYS, state },
  );
}

export async function readLockState(page: Page) {
  return page.evaluate(
    (keys) => ({
      enabled: localStorage.getItem(keys.enabled),
      timeout: localStorage.getItem(keys.timeout),
      deviceCredential: localStorage.getItem(keys.deviceCredential),
      locked: localStorage.getItem(keys.locked),
    }),
    KEYS,
  );
}

/**
 * Pushes "last active" into the past so the next idle check times out at once.
 * Far more reliable than waiting a real 60 seconds, and the criterion (shouldLock) is a pure function with unit tests; what's verified here is whether the overlay
 * really appears when time is up, not arithmetic.
 */
export async function travelPastIdle(page: Page, minutes: number) {
  await page.evaluate(
    ({ keys, ms }) => {
      localStorage.setItem(keys.lastActive, String(Date.now() - ms));
    },
    { keys: KEYS, ms: minutes * 60_000 + 5_000 },
  );
}

/** Dismisses the post-login "add a passkey" prompt so it doesn't block later assertions. */
export async function dismissPasskeyPrompt(page: Page) {
  await page.evaluate((keys) => localStorage.setItem(keys.promptDismissed, "1"), KEYS);
}

/**
 * From zero to "lock enabled": create user -> dismiss the prompt -> flip the switch and run the real ceremony.
 * The caller must addAuth() first: the authenticator type (platform / USB / no biometrics) is often the test's subject and can't be decided here.
 */
export async function enableLock(page: Page) {
  await signUpAndLogin(page);
  await dismissPasskeyPrompt(page);
  // Hydration must be awaited here: if the next click is swallowed, the whole test is fake from the start (see gotoHydrated).
  await gotoHydrated(page, "/settings");
  const toggle = page.getByRole("switch", { name: /auto-lock/i });
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-checked", "true");
}

/** Pushes the page into the locked state (changes "last active" + reload to trigger comparison) and waits for the lock to really appear. */
export async function lockNow(page: Page, timeoutMinutes = 15) {
  await travelPastIdle(page, timeoutMinutes);
  await page.reload();
  await expect(page.getByRole("button", { name: /unlock with passkey/i })).toBeVisible();
}
