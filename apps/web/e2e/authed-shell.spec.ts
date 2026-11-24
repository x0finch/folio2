import { expect, test } from "@playwright/test";
import { dismissPasskeyPrompt, signUpAndLogin } from "./fixtures/app";

// Authed pages ship a prerendered, data-free skeleton shell; every path serves the same static file.
// HTML checks use raw `request` — a browser would run the JS and hide what was actually served.

const AUTHED_PATHS = ["/", "/accounts", "/insights", "/settings"] as const;

// Hydration errors are recoverable: they never reach `console`, only `pageerror`.
const IS_MISMATCH = /Hydration failed|hydration-mismatch|did not match|React error #(418|423|425)/i;

test.describe("signed out: gets the zero-data shell, then the browser routes to login", () => {
  for (const path of AUTHED_PATHS) {
    test(`${path} → 200 zero-data shell, not a redirect`, async ({ request }) => {
      const res = await request.get(path, { maxRedirects: 0 });
      expect(res.status()).toBe(200);
      const html = await res.text();
      expect(html).toContain('data-slot="skeleton"');
      // The shell is path-independent: no page's content is baked in.
      expect(html).not.toContain("Total net worth");
    });

    test(`${path} → browser lands on /login without hydration errors`, async ({ page }) => {
      const errors: string[] = [];
      page.on("pageerror", (e) => {
        if (IS_MISMATCH.test(e.message)) errors.push(e.message.slice(0, 200));
      });
      await page.goto(path);
      await expect(page).toHaveURL(/\/login$/);
      await expect(page.getByLabel(/email/i)).toBeVisible();
      expect(errors).toEqual([]);
    });
  }

  // The shell is prerendered for `/` but hydrates /login; the root `ClientOnly` skeleton exists for this.
  test("/login hard load has no hydration errors", async ({ page }) => {
    const errors: string[] = [];
    page.on("pageerror", (e) => {
      if (IS_MISMATCH.test(e.message)) errors.push(e.message.slice(0, 200));
    });
    await page.goto("/login");
    await expect(page.getByLabel(/email/i)).toBeVisible();
    await page.waitForLoadState("networkidle");
    expect(errors).toEqual([]);
  });

  test("/login and every authed page are the same bytes", async ({ request }) => {
    // The dev server renders per request; only the build output is one static file.
    test.skip(!process.env.CI, "dev server has no static shell; CI preview build only");
    const login = await (await request.get("/login", { maxRedirects: 0 })).text();
    expect(login).toContain("<!DOCTYPE html>");
    for (const path of AUTHED_PATHS) {
      expect(await (await request.get(path, { maxRedirects: 0 })).text(), path).toBe(login);
    }
  });
});

test.describe("signed in: the server only sends the skeleton shell", () => {
  test("the HTML holds only the skeleton, no data", async ({ page }) => {
    const user = await signUpAndLogin(page);
    // `page.request` shares the browser's cookies, so this is a raw request *with* a session.
    const res = await page.request.get("/", { maxRedirects: 0 });
    expect(res.status()).toBe(200);
    const html = await res.text();

    expect(html).toContain('data-slot="skeleton"');

    // The sidebar user name would always appear under SSR, so this works even for an empty account.
    expect(html).not.toContain(user.name);
    expect(html).not.toContain(user.email);

    // `ssr: false` is inherited by the whole tree; a page that slips out fails silently, so check each.
    for (const path of AUTHED_PATHS) {
      const body = await (await page.request.get(path, { maxRedirects: 0 })).text();
      expect(body, `${path} server HTML must not carry the real shell`).not.toContain(">Overview<");
      expect(body, `${path} server HTML must be the skeleton`).toContain('data-slot="skeleton"');
    }
  });

  test("real shell and data appear in the browser, no hydration errors", async ({ page }) => {
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));

    await signUpAndLogin(page);
    await dismissPasskeyPrompt(page);
    errors.length = 0;

    await page.goto("/");
    await expect(page.getByRole("link", { name: "Overview", exact: true })).toBeVisible();
    // The header subtitle needs syncStatus, so it proves data was fetched in the browser.
    await expect(page.getByText(/sources?$/)).toBeVisible();

    expect(errors).toEqual([]);
  });
});
