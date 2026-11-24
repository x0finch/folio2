import { SYNC_CONCURRENCY } from "@folio/sync";
import { type APIRequestContext, expect, test } from "@playwright/test";
import type { SyncRoundView } from "../src/lib/server/sync/status";
import { dismissPasskeyPrompt, signUpAndLogin } from "./fixtures/app";
import {
  accountIdByLabel,
  addBinanceAccount,
  blockPostCreateSync,
  clickSyncPill,
  hoverSyncPill,
  setUpstream,
  snapshotCount,
  unblockPostCreateSync,
  upstream,
  waitForSnapshot,
  waitForSnapshots,
  waitForUpstreamHit,
} from "./fixtures/sync";

// End-to-end check of the sync path. An e2e account that syncs successfully was impossible: of the 9 connectors only manual stays offline
// and manual is excluded from sync, while the other 8 call external APIs (binding CI to third-party availability). The way out: Binance's base URL
// is overridable in production (provider creds), so pointing it at a local fake server gives an offline, always-succeeding upstream with
// controllable speed, via a mechanism production also runs, with no test branch in production code.
// The core promise: running and watching are separate, so closing the tab doesn't stop the sync. Even the watching half is polling of the round
// record, not a stream, so after the page closes what remains is a background job tied to no connection (one job per account, run by the runner Durable Object's alarm; Miniflare simulates it locally).

/** A snapshot with a balance whose quantity is exactly amount. Asserts balance quantity, not totalUsd: quantity comes straight from the provider, without revaluation. */
const holds = (amount: number) => (s: { balances: { amount: number }[] }) =>
  s.balances.some((b) => b.amount === amount);

test.describe("sync round", () => {
  // The default 30s isn't enough for this group: each case registers a user, adds accounts from the UI (each creation also enqueues a sync + warmup to the
  // runner), then waits for a round to land. Relax the whole group instead of letting individual cases randomly break through when congested.
  test.describe.configure({ timeout: 120_000 });

  test('click sync -> all accounts get snapshots, reports "N synced"', async ({
    page,
    request,
  }) => {
    await setUpstream(request, { delayMs: 0, spotBtc: "1.50000000" });
    await signUpAndLogin(page);
    await dismissPasskeyPrompt(page);
    await page.goto("/accounts");

    await addBinanceAccount(page, "Spot A");
    await addBinanceAccount(page, "Spot B");
    const idA = await accountIdByLabel(page, "Spot A");
    const idB = await accountIdByLabel(page, "Spot B");

    // The add-account modal runs a background sync itself (add-account-modal's handleDone); wait those two out, or "click sync" below may measure their tail.
    await waitForSnapshot(
      page,
      idA,
      holds(1.5),
      "Spot A's first sync after creation didn't persist",
    );
    await waitForSnapshot(
      page,
      idB,
      holds(1.5),
      "Spot B's first sync after creation didn't persist",
    );

    // Change the quantity so "is there a new snapshot" doesn't rely on guessing timestamps: the number itself shows it was freshly fetched.
    await setUpstream(request, { spotBtc: "3.25000000" });

    await page.reload(); // so the header pill gets the "all synced" summary
    await clickSyncPill(page);

    // The completion signal is in the panel and the round's result is server fact: `POST /api/sync` returns only a just-opened round (0 / 2),
    // so "2 synced" can only come from polling reading back the closed-out round; this assertion itself proves the polling path works.
    await hoverSyncPill(page);
    await expect(page.getByText("2 synced")).toBeVisible({ timeout: 30_000 });
    await waitForSnapshot(
      page,
      idA,
      holds(3.25),
      "Spot A's snapshot for this round didn't persist",
    );
    await waitForSnapshot(
      page,
      idB,
      holds(3.25),
      "Spot B's snapshot for this round didn't persist",
    );
    // Two more pins: no failure block + the pill settles back to "Synced" (a problem this round would turn it amber "Needs attention").
    await expect(page.getByText("Failed this round")).toHaveCount(0);
    await expect(page.getByRole("button", { name: /^Synced$/ })).toBeVisible({ timeout: 30_000 });
  });

  // This case is the reason for the whole file: if it fails, the core promise (running and watching are separate) is false.
  // It pins "when the connection is gone the round is unaffected": `POST /api/sync` already returned, and each account is a background job run by the runner
  // with results written to the DB, not pushed to a connection. It runs a real disconnect + real persistence (Miniflare's real Durable Object + alarm), which
  // unit tests can't. It guards against design regressions (going pull-based / tying the run to a connection or request). Local and production differ: Miniflare's
  // DO has different CPU limits, so green doesn't mean production is fine.
  test("close the tab mid-sync -> the server still finishes the round", async ({
    page,
    context,
    request,
  }) => {
    await setUpstream(request, { delayMs: 0, spotBtc: "1.50000000" });
    await signUpAndLogin(page);
    await dismissPasskeyPrompt(page);
    await page.goto("/accounts");

    await addBinanceAccount(page, "Cold spot");
    const accountId = await accountIdByLabel(page, "Cold spot");
    await waitForSnapshot(page, accountId, holds(1.5), "first sync after creation didn't persist");

    // Make the upstream slow and different: slow enough to close the tab midway; the changed quantity means a new number read later was written after closing.
    // Reset hits to zero so it's clear when the round really starts.
    await setUpstream(request, { delayMs: 4_000, spotBtc: "7.00000000", hits: 0 });

    await page.reload();
    await clickSyncPill(page);
    await waitForUpstreamHit(request); // the server is pulling the upstream, which still takes 4 seconds to reply

    // Close the "watching" half. From here everything depends on the server finishing by itself.
    const closedAt = Date.now();
    await page.close();

    // Read from another page (same context -> same cookie) to prove the data persisted rather than staying in some page's memory.
    const reader = await context.newPage();
    await reader.goto("/accounts");
    const snapshot = await waitForSnapshot(
      reader,
      accountId,
      holds(7),
      "the round didn't finish after the tab closed -- the core promise isn't kept",
    );

    // It must also have been written after closing: takenAt is taken when the snapshot is written (sync/account.ts), not when the run starts.
    expect(
      snapshot.takenAt,
      `snapshot takenAt=${snapshot.takenAt} is not later than the close time ${closedAt}, so it was written before closing and proves nothing`,
    ).toBeGreaterThan(closedAt);
  });

  // The case above shows a round already started isn't cut off; this goes further: it keeps picking up new jobs after the page closes. The account count is
  // deliberately SYNC_CONCURRENCY + 2: even with SYNC_CONCURRENCY running at once, at least two queued ones at close time haven't sent a single upstream request,
  // and they still produce snapshots, showing the server drains queued work rather than stopping at what's in hand. The runner is single-threaded (one alarm,
  // one job), so even more are "not yet up" and "<= concurrency cap" below still holds; the cost is a slower round, hence the relaxed wait cap. Unit tests can't
  // replace this: it needs the property to hold under a real disconnect. The constant comes from @folio/sync, not hard-coded, so a changed cap changes this case too
  // instead of quietly degrading into "all 8 concurrent" (which would test nothing).
  const ACCOUNT_COUNT = SYNC_CONCURRENCY + 2;
  test(`accounts still queued when the tab closes (${ACCOUNT_COUNT} > concurrency ${SYNC_CONCURRENCY}) -> they finish too`, async ({
    page,
    context,
    request,
  }) => {
    // Eight accounts are added one by one from the UI, so this is the file's slowest case; the runner running eight slow accounts serially also takes time.
    test.setTimeout(300_000);
    await setUpstream(request, { delayMs: 0, spotBtc: "7.00000000", hits: 0 });
    await signUpAndLogin(page);
    await dismissPasskeyPrompt(page);
    await page.goto("/accounts");

    // During account creation, block the post-create background sync (see blockPostCreateSync: it's slow and they block each other). With it blocked, these eight
    // accounts have no snapshot at all before the round under test, so the assertion is cleaner.
    await blockPostCreateSync(page);
    const labels = Array.from({ length: ACCOUNT_COUNT }, (_, i) => `Spot ${i + 1}`);
    for (const label of labels) await addBinanceAccount(page, label);
    await unblockPostCreateSync(page);

    const ids: string[] = [];
    for (const label of labels) ids.push(await accountIdByLabel(page, label));
    expect(
      await snapshotCount(page),
      "these eight accounts should have no snapshot at this point (post-create background sync is blocked)",
    ).toBe(0);

    // Slow the upstream: slow enough to close the tab midway, and for the two accounts behind the concurrency window to not yet be up.
    await setUpstream(request, { delayMs: 3_000, hits: 0 });

    await page.reload();
    await clickSyncPill(page);
    await waitForUpstreamHit(request);

    const hitsAtClose = (await upstream(request)).hits;
    const closedAt = Date.now();
    await page.close();

    const reader = await context.newPage();
    await reader.goto("/accounts");
    const snapshots = await waitForSnapshots(
      reader,
      ids,
      holds(7),
      `${ACCOUNT_COUNT} accounts didn't all finish -- the server stops taking new jobs after the page closes`,
      180_000,
    );

    for (const [i, snapshot] of snapshots.entries()) {
      expect(
        snapshot.takenAt,
        `${labels[i]}'s snapshot takenAt=${snapshot.takenAt} is not later than the close time ${closedAt}`,
      ).toBeGreaterThan(closedAt);
    }

    // "Requests started after the page closed": ask the fake upstream for the count directly.
    const finalHits = (await upstream(request)).hits;
    expect(
      hitsAtClose,
      "no new request was sent after the page closed -- so there's no such thing as 'keep taking new jobs'",
    ).toBeLessThan(finalHits);
    // Each account's round hits a fixed set of endpoints -> the number of "touched" accounts at close time shouldn't exceed the concurrency cap,
    // i.e. at least two haven't made a single call. Failing here usually means the cap changed and this case needs its numbers reworked.
    const perAccount = finalHits / ACCOUNT_COUNT;
    expect(
      hitsAtClose / perAccount,
      `${hitsAtClose / perAccount} accounts had touched the upstream at close time, over the concurrency cap ${SYNC_CONCURRENCY} -- so no account was "not yet up" and this case tests nothing`,
    ).toBeLessThanOrEqual(SYNC_CONCURRENCY);
  });
});

// How the panel reads a round's result. The `POST /api/sync` response is replaced directly: the server wouldn't easily produce these combinations (accounts missing
// credentials, the round never started, a worker dying midway), and the response is the round's current state which the frontend writes straight into the cache.
// Closed-out / interrupted rounds don't trigger polling again (`refetchInterval` is on only while running), so the fabricated one is what the panel keeps reading and there's
// no need to intercept the server fn address. One more precondition: nothing else re-reads the round. The post-create background sync is also a round, so a real one exists
// before clicking sync, and swapping in the response counts as "progress advances one step"; that step refreshes the data domain, not the round itself (`REFRESH_MAP["sync.round"]`):
// if it marked the round stale too, the immediately following GET would swap the response back to the real round and the panel would show "All synced", which is this rule's e2e pin.
// The only other thing that re-reads the round is the data version number (on returning to the page / each minute), not hit in these cases.
test.describe("panel reading a round", () => {
  // Typed: the panel reads by `SyncRoundView`'s fields, so fixture drift (renamed field / new required field) must turn red at compile time rather than silently show an empty panel in the browser.
  const roundView = (over: Partial<SyncRoundView>) => ({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({
      roundId: "e2e-round",
      state: "done",
      trigger: "manual",
      startedAt: Date.now() - 1000,
      finishedAt: Date.now(),
      total: 2,
      settled: 2,
      synced: 1,
      failed: [],
      needsKeys: 0,
      skipped: 0,
      current: null,
      unresolved: 0,
      error: null,
      statuses: {},
      ...over,
    } satisfies SyncRoundView),
  });

  const withOneAccount = async (
    page: Parameters<typeof dismissPasskeyPrompt>[0],
    request: APIRequestContext,
  ) => {
    await setUpstream(request, { delayMs: 0 });
    await signUpAndLogin(page);
    await dismissPasskeyPrompt(page);
    await page.goto("/accounts");
    await addBinanceAccount(page, "Spot A");
    // Wait for the post-create background sync to finish (it's a round of this portfolio, see addBinanceAccount's comment).
    // Otherwise on reload that round may still be running: the pill spins, clicking sends no POST, and swapping the response is moot.
    await waitForSnapshot(
      page,
      await accountIdByLabel(page, "Spot A"),
      () => true,
      "first sync after creation didn't persist",
    );
  };

  // Each tier's wording and badge (round never started / interrupted / per-item failures) are pinned by `tests/sync-panel.test.tsx`; only one case stays here, checking that the response -> pill -> panel wiring works in a real browser.
  test('an account missing credentials counts as "needs credentials", not a failure', async ({
    page,
    request,
  }) => {
    await withOneAccount(page, request);
    await page.route("**/api/sync", (route) => route.fulfill(roundView({ needsKeys: 1 })));

    await page.reload();
    await clickSyncPill(page);

    // Missing credentials is its own tier: the user just hasn't entered the API key, which is not an error.
    // Anchor the whole string: Playwright's string name is a substring match, so a bare "Synced" would also hit the account row's "Synced now" and strict mode would blow up.
    await expect(page.getByRole("button", { name: /^Synced$/ })).toBeVisible({ timeout: 30_000 });
    await hoverSyncPill(page);
    // The panel text reads the same round data and should follow the pill, but under CI's 2-core cold compile it is occasionally slower than the default 15s (the pill step already gets 30s);
    // aligned to 30s: this fixes the race of the assertion outrunning a slow machine, not product behavior.
    await expect(page.getByText("1 need keys")).toBeVisible({ timeout: 30_000 });
    await expect(page.getByText("Failed this round")).toHaveCount(0);
  });
});
