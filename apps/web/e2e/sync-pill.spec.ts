import { expect, test } from "@playwright/test";
import { dismissPasskeyPrompt, signUpAndLogin } from "./fixtures/app";
import {
  addBinanceAccount,
  blockPostCreateSync,
  hoverSyncPill,
  setUpstream,
} from "./fixtures/sync";

// Hovering the sync pill opens the hover panel, whose visible area on the first frame is exactly the pill and layered above it, so a
// click right after moving in has mousedown on the pill and mouseup on the panel: click goes to their common ancestor and sync doesn't fire
// (real users hit it within ~100ms of moving in). Unit tests can't reproduce it: it needs real-browser hit testing and the popover animation's real timing.
test.describe("sync pill", () => {
  test.describe.configure({ timeout: 120_000 });

  test("click right after hovering in -> still starts a sync, not swallowed by the opening panel", async ({
    page,
    request,
  }) => {
    await setUpstream(request, { delayMs: 0, spotBtc: "1.50000000" });
    await signUpAndLogin(page);
    await dismissPasskeyPrompt(page);
    // Block the automatic sync after account creation: it would turn the pill into "Syncing..." mid-test, and clicking while busy sends no request
    // (sync() returns when busy). This case tests whether the click lands, so no prior round is needed.
    await blockPostCreateSync(page);
    await page.goto("/accounts");
    await addBinanceAccount(page, "Quick click");
    await page.reload();

    const pill = page.getByRole("button", { name: /^(Synced|Needs attention)$/ });
    await expect(pill).toBeVisible();
    // Confirm the page is hydrated (hover can open the panel), then move the cursor away and wait for the panel to close, so the next move-in is clean.
    await hoverSyncPill(page);
    await page.mouse.move(0, 0);
    await expect(pill).toHaveAttribute("aria-expanded", "false", { timeout: 5_000 });

    const box = await pill.boundingBox();
    if (!box) throw new Error("sync pill not visible");
    const synced = page.waitForRequest(
      (r) => r.url().includes("/api/sync") && r.method() === "POST",
      { timeout: 5_000 },
    );
    // Move in, press and release at once, without waiting for the panel to finish opening.
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.up();
    await synced;
  });
});
