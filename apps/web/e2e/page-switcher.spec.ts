import { expect, type Page, test } from "@playwright/test";
import { dismissPasskeyPrompt, signUpAndLogin } from "./fixtures/app";
import { accountIdByLabel, addBinanceAccount } from "./fixtures/sync";

// Browser-only properties of the single-route `<Activity>` page switcher: per-page first-visit
// skeleton, instant revisits, keep-alive state, a steady sync bar, strict lazy loading, one-shot
// `?focus`. Remounting on `params.page` would silently reset page state, which unit tests can't see.
// The insights chunk is held back so its skeleton is observable; a MutationObserver records any
// skeleton that flashes during a revisit.

// Literals unique to the insights and accounts chunks (file names are hashed and differ in dev).
const INSIGHTS_MARKER = "insights-trend:";
const ACCOUNTS_MARKER = "account-row-";
const INSIGHTS_CHUNK_DELAY_MS = 1_500;

// Records which page chunks were fetched and delays the insights one.
async function interceptChunks(page: Page) {
  const requested = new Set<string>();
  await page.route(
    (url) => /\.(?:m?js|tsx?)(?:\?.*)?$/.test(url.pathname),
    async (route) => {
      const response = await route.fetch();
      const body = await response.text();
      if (body.includes(ACCOUNTS_MARKER)) requested.add("accounts");
      if (body.includes(INSIGHTS_MARKER)) {
        requested.add("insights");
        await new Promise((r) => setTimeout(r, INSIGHTS_CHUNK_DELAY_MS));
      }
      await route.fulfill({ response, body });
    },
  );
  return requested;
}

// Records every `[data-page-skeleton]` inserted into the DOM from now on.
async function watchSkeletons(page: Page) {
  await page.evaluate(() => {
    const seen: string[] = [];
    const record = (node: Node) => {
      if (!(node instanceof HTMLElement)) return;
      const own = node.dataset.pageSkeleton;
      if (own) seen.push(own);
      for (const el of node.querySelectorAll<HTMLElement>("[data-page-skeleton]")) {
        seen.push(el.dataset.pageSkeleton ?? "");
      }
    };
    new MutationObserver((records) => {
      for (const r of records) r.addedNodes.forEach(record);
    }).observe(document.body, { childList: true, subtree: true });
    (window as unknown as { __skeletons: string[] }).__skeletons = seen;
  });
}

const skeletonsSeen = (page: Page) =>
  page.evaluate(() => (window as unknown as { __skeletons: string[] }).__skeletons);

// Document-relative, not viewport-relative: clicking "By chain" can scroll the page on mobile.
const headerSyncTop = (page: Page) =>
  page
    .locator('[data-slot="header-sync"]:visible')
    .evaluate((el) => Math.round(el.getBoundingClientRect().top + window.scrollY));

test.describe("page switcher: one route + Activity keep-alive", () => {
  test.describe.configure({ timeout: 90_000 });
  // The Dock only renders at the phone breakpoint.
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true });

  test("own skeleton, instant revisit, keep-alive, steady sync bar, lazy", async ({ page }) => {
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(String(e)));
    const requested = await interceptChunks(page);

    await signUpAndLogin(page);
    await dismissPasskeyPrompt(page);

    await page.goto("/insights");
    await expect(page).toHaveURL(/\/insights$/);
    await expect(page.locator('[data-page-skeleton="insights"]')).toBeVisible();
    const byChain = page.getByRole("tab", { name: "By chain" });
    await expect(byChain).toBeVisible();
    await expect(page.locator("[data-page-skeleton]")).toHaveCount(0);

    // Strict lazy: unvisited pages are not mounted and their chunks are not fetched.
    await expect(page.locator('[data-page="accounts"]')).toHaveCount(0);
    await expect(page.locator('[data-page="overview"]')).toHaveCount(0);
    expect(requested.has("accounts"), "unvisited accounts chunk must not be fetched").toBe(false);

    // Component-local state, not in the URL. Retry: clicks before hydration are silently dropped.
    await expect(async () => {
      await byChain.click();
      await expect(byChain).toHaveAttribute("aria-selected", "true");
    }).toPass({ timeout: 15_000 });
    await expect(page).toHaveURL(/\/insights$/);

    const topBefore = await headerSyncTop(page);
    await page.locator('nav.fixed a[href="/"]').click();
    await expect(page).toHaveURL(/\/$/);
    await expect(page.locator('[data-page="overview"]')).toBeVisible();
    // The sync bar is absolute to the shell's <main> and must not move with page content.
    expect(await headerSyncTop(page)).toBe(topBefore);

    await watchSkeletons(page);
    await page.locator('nav.fixed a[href="/insights"]').click();
    await expect(page).toHaveURL(/\/insights$/);
    // Keep-alive: the component was not remounted.
    await expect(byChain).toHaveAttribute("aria-selected", "true");
    expect(await skeletonsSeen(page)).not.toContain("insights");
    expect(await headerSyncTop(page)).toBe(topBefore);
    await expect(page.locator('[data-page="overview"]')).toHaveCount(1);
    await expect(page.locator('[data-page="accounts"]')).toHaveCount(0);

    expect(errors, `pageerror during switching: ${errors.join("; ")}`).toEqual([]);
  });

  test("an unknown path segment is a 404, not an empty shell", async ({ page }) => {
    await signUpAndLogin(page);
    await dismissPasskeyPrompt(page);
    // The optional param accepts anything, so `/anything` would otherwise render an empty shell.
    await page.goto("/anything");
    await expect(page.getByText("Not Found")).toBeVisible();
    await expect(page.locator("[data-page]")).toHaveCount(0);
  });

  test("?focus is one-shot: scrolls to the row, then is removed from the URL", async ({ page }) => {
    await signUpAndLogin(page);
    await dismissPasskeyPrompt(page);
    await page.goto("/accounts");
    await addBinanceAccount(page, "E2E Focus");
    const id = await accountIdByLabel(page, "E2E Focus");

    // The URL the sync panel links to.
    await page.goto(`/accounts?focus=${id}`);
    // A command, not state: a reload must not focus again.
    await expect(page.locator(`[id="account-row-${id}"]`)).toBeVisible();
    await expect(page).toHaveURL(/\/accounts$/);
  });
});
