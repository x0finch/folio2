import { expect, type Page, test } from "@playwright/test";
import { dismissPasskeyPrompt, signUpAndLogin } from "./fixtures/app";

// The selected portfolio lives in the URL. This covers only what can come together in a browser: switching adds a param to the address, the header sync summary
// follows, Back returns to the previous portfolio, refresh stays on it, a trip through settings keeps the param, in-page view changes don't enter the address, and switching
// back to default drops the param. The two pure rules (which portfolio to read back / the new query string after switching) are pinned by `tests/portfolio-selection.test.ts`.
// Why e2e: each needs address + history stack + search middleware + route loader all present, and they fail silently (forgetting to retain it across pages just flips the portfolio
// after a settings change; forgetting push makes Back skip the switch; forgetting to clear the old param carries the old portfolio's view into the new one).
// A second portfolio can only be made through the real UI: the create entry lives in the account drawer's "move to portfolio" (the selector appears only with >=2 portfolios, a chicken-and-egg),
// so make a manual account first; this also makes the two portfolios look different (default has one account, the new one is empty) so "the screen follows the address" can be asserted.
// Refresh and Back are verified separately: pressing Back in the few hundred ms right after load makes the router miss that popstate (its subscription is attached in `Transitioner`'s
// effect, so a popstate before hydration has no listener and history doesn't replay it), leaving the address back but the UI on the old portfolio. A real user can't hit that window,
// Playwright can, so this doesn't manufacture the race rather than assert it as correct.

const ACCOUNT = "E2E Manual";
const SECOND = "Watch";

test.describe("portfolio selection in the URL", () => {
  // The setup is a chain of real UI actions (create account -> open drawer -> new portfolio), heavier than usual specs, so relax the whole group.
  test.describe.configure({ timeout: 120_000 });

  test("switching portfolio shows up in the address bar; Back / refresh / navigating across pages follow it", async ({
    page,
  }) => {
    const user = await signUpAndLogin(page);
    // The default portfolio's name derives from the signup name (`<name>'s`, see @folio/db ensureDefault) and differs every run,
    // so compute it instead of guessing from the page by shape which row it is.
    const DEFAULT = `${user.name}'s`;
    await dismissPasskeyPrompt(page);
    await page.goto("/accounts");
    await addManualAccount(page);
    await addPortfolio(page, SECOND);

    // The selector appearing = the second portfolio was really created (it renders only with >=2 portfolios).
    await expect(page.getByRole("button", { name: "Portfolio", exact: true })).toBeVisible({
      timeout: 30_000,
    });
    // The default portfolio's address is clean: default isn't written to the URL.
    await expect(page).toHaveURL(/\/accounts$/);
    const row = page.getByRole("button").filter({ hasText: ACCOUNT }).first();
    await expect(row).toBeVisible();
    // Header summary baseline: the one manual account in the default portfolio.
    await expect(sourceCount(page)).toHaveText("1");

    // -- 1: switch to a non-default portfolio: the address gains a param, the screen follows --
    await switchTo(page, SECOND);
    await expect(page).toHaveURL(/\/accounts\?portfolio=[^&]+$/);
    const watchUrl = page.url();
    // The header pill must show **only the new portfolio's name**. Switching to a never-seen portfolio, the header sync summary's data isn't in cache yet; if the loader
    // doesn't wait for it the shell suspends, Suspense hides it whole (display:none) for tens of ms and shows a skeleton shell. The pill's text-roll animation starts in that
    // stretch: a hidden element can't be measured so the old name can't exit and both names sit side by side until the next switch (seen on a production build; `toHaveText`
    // matches the full text, so one extra word fails). The node isn't removed, only hidden, so "node still connected" assertions miss it; assert the line the user sees.
    await expect(page.getByRole("button", { name: "Portfolio", exact: true })).toHaveText(SECOND);
    // No accounts in the new portfolio yet. Filter by visibility first, then assert: while data swaps, two copies of the list exist in the DOM (React keeps the old one with `hidden`
    // until the new data is ready, which is the "no skeleton flash" mechanism). `toBeVisible()` alone doesn't help: strict mode counts matches first and errors on two, and `getByText`
    // also matches hidden ones (seen on CI, not reproducible locally).
    await expect(emptyList(page)).toBeVisible();
    // The header sync summary changed too: it's fetched per selected portfolio, not the global one.
    await expect(sourceCount(page)).toHaveText("0");

    // -- 2: Back undoes this switch (so switching portfolio uses `push`, not `replace`) --
    await page.goBack();
    await expect(page).toHaveURL(/\/accounts$/);
    await expect(row).toBeVisible();
    await expect(sourceCount(page)).toHaveText("1");

    // -- 3: refresh: still on this portfolio --
    await switchTo(page, SECOND);
    await expect(page).toHaveURL(watchUrl);
    await page.reload();
    await expect(page).toHaveURL(watchUrl);
    await expect(emptyList(page)).toBeVisible();

    // -- 4: a trip through settings and back, the param is still there --
    // Use the sidebar link (client navigation) rather than `goto`: what's verified is that links automatically carry the param, done by the layout layer's `retainSearchParams`,
    // which no call site writes. Wrapped in `toPass`: just after the refresh, a click before hydration finishes is silently swallowed (see gotoHydrated's comment in fixtures/app.ts); retry until it really navigates.
    await expect(async () => {
      await page.locator('aside a[href^="/settings"]').click();
      await expect(page).toHaveURL(/\/settings\?portfolio=/, { timeout: 2_000 });
    }).toPass({ timeout: 30_000 });
    await page.locator('aside a[href^="/accounts"]').click();
    await expect(page).toHaveURL(watchUrl);

    // -- 5: in-page view changes don't enter the address --
    // The distribution dimension lives in AllocationCard's internal state, so an old portfolio's view param following along is structurally impossible and the address only ever has `?portfolio`.
    // Assert positively: switch to a non-default dimension, the pie tab's selected state changes but the address gains not one character.
    await page.locator('aside a[href^="/insights"]').click();
    await expect(page).toHaveURL(/\/insights\?portfolio=/);
    const beforeDim = page.url();
    const byChain = page.getByRole("tab", { name: "By chain" });
    await byChain.click();
    await expect(byChain).toHaveAttribute("aria-selected", "true");
    await expect(page).toHaveURL(beforeDim);

    // -- 6: switch back to default: `?portfolio` disappears and the address returns to a clean /insights --
    await switchTo(page, DEFAULT);
    await expect(page).toHaveURL(/\/insights$/);
  });
});

/** The "no accounts yet" line: only the **visible** copy counts (see the comment at step 1 above). */
const emptyList = (page: Page) => page.getByText("No accounts yet.").filter({ visible: true });

/**
 * The "Sources N" number in the header sync panel. The summary is fetched per selected portfolio (`ShellWithSync` fetches inside the Provider), so this number is
 * the most direct evidence that the header follows the portfolio: move that query back outside the Provider and it always shows the default one, failing here.
 * No hover to open the panel: the content is always in the DOM (the popover only collapses it), and what's verified is whether data is wired, not the popover animation.
 * This is a round-less state (no round ever runs in this spec, manual accounts don't enter rounds), so the line says "how many sources this portfolio has".
 * `exact` is required: `getByText` with a string is a case-insensitive substring match and the header subtitle says "across N sources", so without it strict mode reports two elements.
 */
const sourceCount = (page: Page) =>
  page.getByText("Sources", { exact: true }).locator("xpath=following-sibling::span[1]");

/**
 * Switches to a portfolio from the header selector. The selector is a hover popover: hover the trigger, then click the option (they're adjacent vertically, so a straight mouse path
 * doesn't pass over anything else). `exact` is required: a bare "Portfolio" would also match "Manage portfolios" in the same popover (strict mode reports two elements).
 */
async function switchTo(page: Page, name: string) {
  await page.getByRole("button", { name: "Portfolio", exact: true }).hover();
  await page.getByRole("button", { name, exact: true }).first().click();
}

/** Creates a manual account (offline, always succeeds). Steps and pitfalls match `manual-gain.spec.ts`, which comments each one. */
async function addManualAccount(page: Page) {
  const scrim = page.getByRole("button", { name: "Close modal" });
  await expect(async () => {
    if ((await scrim.count()) === 0) {
      await page.getByRole("button", { name: /add account/i }).click();
    }
    await expect(page.getByRole("button", { name: /Manual$/i })).toBeVisible({ timeout: 2_000 });
  }).toPass({ timeout: 30_000 });

  await page.getByRole("button", { name: /Manual$/i }).click();
  // The token picker searches over the network; switch to plain text input so e2e never touches the upstream.
  await page.getByRole("button", { name: /enter a symbol manually/i }).click();
  await page.locator("#m-token").fill("BTC");
  await page.locator("#m-amount").fill("2");
  await page.locator("#m-price").fill("50000");
  await page.locator("#add-label").fill(ACCOUNT);
  // Submit with Enter: the scrim is a full-screen close button and during the morph animation a click on the button gets caught by it.
  await page.locator("#add-label").press("Enter");
  await expect(scrim).toHaveCount(0, { timeout: 30_000 });
}

/**
 * Creates another portfolio. The only entry: account drawer -> more actions -> move to portfolio -> "New portfolio" at bottom left. After creating, don't select it (no account move);
 * just **reload the whole page**, which is steadier than closing the drawer and dialog layer by layer and gives every later step a clean accounts page.
 */
async function addPortfolio(page: Page, name: string) {
  await page.getByRole("button").filter({ hasText: ACCOUNT }).first().click();
  await page.getByRole("button", { name: "More actions" }).hover();
  await page.getByRole("button", { name: /move to/i }).click();
  // This entry's label changes to "Click to create" on hover / focus (AnimatedBadge's text-roll); accept both.
  await page.getByRole("button", { name: /new portfolio|click to create/i }).click();
  await page.getByPlaceholder("New portfolio name").fill(name);
  await page.getByRole("button", { name: "Create", exact: true }).click();
  // Back in the "move to portfolio" list the new portfolio appears, confirming the creation really succeeded.
  await expect(page.getByRole("button", { name, exact: true }).first()).toBeVisible({
    timeout: 30_000,
  });
  await page.goto("/accounts");
}
