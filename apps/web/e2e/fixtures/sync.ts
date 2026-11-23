import { type APIRequestContext, expect, type Page } from "@playwright/test";

// Shared pieces for the sync-path e2e: steering the fake upstream, adding an account that can sync successfully, reading back persisted snapshots.
// Separate from app.ts because that one holds the idle-lock / passkey setup props (localStorage keys, virtual authenticator), which don't overlap.

export const FAKE_BINANCE_URL = "http://localhost:3099";

interface UpstreamState {
  /** How long each request is artificially delayed -- slows sync enough to close the tab midway. */
  delayMs: number;
  /** Quantity of the spot BTC holding (a string, goes into the snapshot as is). */
  spotBtc: string;
  /** BTCUSDT price. */
  btcPrice: string;
  /** Cumulative requests the fake server has received (increase-only; can be reset to 0). */
  hits: number;
}

/**
 * Changes the fake upstream's behavior and returns the full state afterwards.
 * Uses the `request` fixture rather than `page.request`: it isn't bound to baseURL and doesn't die with the page; the "close the tab" case keeps steering the upstream after the page is gone.
 */
export async function setUpstream(
  request: APIRequestContext,
  patch: Partial<UpstreamState>,
): Promise<UpstreamState> {
  const res = await request.post(`${FAKE_BINANCE_URL}/__control`, { data: patch });
  expect(res.ok(), `fake binance rejected ${JSON.stringify(patch)}: ${await res.text()}`).toBe(
    true,
  );
  return res.json();
}

export async function upstream(request: APIRequestContext): Promise<UpstreamState> {
  return (await request.get(`${FAKE_BINANCE_URL}/__control`)).json();
}

/**
 * Adds a Binance account through the UI (fake key, hits the local fake server).
 * Through the UI rather than calling the server function directly: the server fn's call address is a compile-time artifact (with a hash id), so building it in a test would pin a build-dependent internal detail; "add account" is a user action with a UI anyway, so clicking through also covers the create flow.
 * Note: after creation add-account-modal runs a background `syncAccount` itself (its handleDone); it only queues the account into a round and enqueues a background job, with the real sync run by the local (Miniflare) runner DO,
 * so an account may get a snapshot at any time after this returns. Tests measuring "the round started by this click" must wait that one out first.
 */
export async function addBinanceAccount(page: Page, label: string) {
  // Click until the modal really opens. Not to wait out a duration: right after goto the accounts page may not have attached handlers and the click is silently swallowed (no error, no effect),
  // surfacing only seconds later as "Binance not found" (see gotoHydrated's comment in app.ts; the accounts page has no client-only request to wait on, hence the retry click).
  // Never click again while open: the modal's scrim is a full-screen "close" button that would intercept the click and stall the retry loop until timeout.
  // Name /Binance$/i rather than exact "Binance": the grid cell's accessible name is "initial + name" (the LogoAvatar fallback initial span stays in the DOM), seen as `B Binance`, so exact fails;
  // a bare substring would also hit an existing Binance account row on the accounts page ("label Binance last synced ..."), and strict mode reports two elements, so anchor at the end.
  // Case-insensitive also tolerates the moment the connector catalogue isn't ready and the name is the lowercase id.
  const grid = page.getByRole("button", { name: /Binance$/i });
  const scrim = page.getByRole("button", { name: "Close modal" });

  // The previous modal must fully exit first. It's a MorphingModal with an exit animation: during the few hundred ms the scrim is still mounted the loop below thinks it is "already open"
  // and doesn't click, then waits for a grid that doesn't exist; adding eight accounts in a row really hits this.
  await expect(scrim).toHaveCount(0, { timeout: 10_000 });

  await expect(async () => {
    if ((await scrim.count()) === 0) {
      await page.getByRole("button", { name: "Add account" }).click();
    }
    await expect(grid).toBeVisible({ timeout: 2_000 });
  }).toPass({ timeout: 20_000 });
  await grid.click();

  await page.locator("#add-label").fill(label);
  await page.locator("#add-apiKey").fill("e2e-fake-api-key");
  await page.locator("#add-secret").fill("e2e-fake-api-secret");

  const form = page.locator("form").filter({ has: page.locator("#add-label") });
  const failure = form.locator("p.text-destructive"); // the red line for AccountForm's mutation.isError

  // Submit with Enter, not the button: the modal's scrim is a full-screen "close" button and grid -> form is a morph animation; after the click's hit test passes and before the real mouse event
  // lands the layout is still moving and the scrim catches it, so the modal closes with no account created and no error (reproducible when adding eight in a row).
  // Enter goes through the form's onSubmit, no coordinate hit test, and is a real user action too.
  await page.locator("#add-secret").press("Enter");

  // Creation really hits the fake server to validate credentials (validateAccount), which also proves the worker points at the fake server.
  // Match the button containing this label (the account row), not any occurrence of the label on the page: the sync panel's "not synced" list also shows it and bare text matching hits two elements
  // (that list isn't in a button, so filtering by button is clean). Don't match on accessible name: the row's name is a long concatenation (label + Binance + last sync + amount + change) and with many
  // accounts the label may not come first, so `^label` mysteriously fails (from the seventh account on); "this button contains this text" is stable.
  // Also watch the red line: when rejected, throw the upstream's reason directly, or the failure shows only as "account row didn't appear" with the real cause (e.g. not pointed at the fake server -> binance auth failed) hidden in a line nobody reads.
  const row = page.getByRole("button").filter({ has: page.getByText(label, { exact: true }) });
  await expect(async () => {
    // count() first, then read the text. Don't call textContent() directly: with no match it waits until actionTimeout (15s in this repo) before throwing, while "no red line" is the normal case,
    // so each added account would burn 15s and eight accounts climb past two minutes. count() returns at once.
    const rejected = (await failure.count()) > 0 ? await failure.first().textContent() : null;
    expect(
      rejected,
      `account creation rejected: ${rejected} -- if it's binance auth failed, the app isn't pointed at the fake server; start the server with CLOUDFLARE_ENV=test (see playwright.config.ts)`,
    ).toBeNull();
    await expect(row).toHaveCount(1, { timeout: 1_000 });
  }).toPass({ timeout: 25_000 });
}

/**
 * Blocks the background sync after account creation, only for creating many accounts at once.
 * Why: add-account-modal's handleDone does `void syncAccount(...)`; that server fn only queues and returns, but each call still enqueues a `sync-account` plus price / rate / platform jobs to the runner, and the runner is serial (one DO, one alarm per job),
 * so eight accounts in a row put dozens of jobs ahead of the round under test. Creating accounts isn't under test, and blocking leaves these accounts with no snapshot before the round under test, so assertions are cleaner.
 * Distinguished by request body, not URL (the server fn address carries a compile-time hash): `syncAccount`'s input is only accountId while `createAccount` carries connectorId/label/values.
 */
export async function blockPostCreateSync(page: Page) {
  await page.route("**/_serverFn/**", async (route) => {
    const body = route.request().postData() ?? "";
    if (body.includes("accountId") && !body.includes("connectorId")) return route.abort();
    return route.fallback();
  });
}

export async function unblockPostCreateSync(page: Page) {
  await page.unroute("**/_serverFn/**");
}

// Hover the header pill to open the sync panel (the desktop popover opens on hover).
// "Open" is judged by the trigger's `aria-expanded="true"` (set by beUI PopoverTrigger, see popover.tsx), not by the panel text being visible: the vendored Popover keeps its content mounted when closed (clipped by clipPath + inert),
// and Playwright's toBeVisible recognizes none of those, so waiting for "Sync status appears" is an always-true false signal.
export async function hoverSyncPill(page: Page) {
  const pill = page.getByRole("button", { name: /^(Synced|Needs attention|Syncing…)$/ });
  await expect(async () => {
    // Move the cursor away first, then hover. These cases mostly click sync and then look at the panel, leaving the cursor centered on the pill; hovering again keeps the same target coordinates, the browser
    // doesn't re-emit mouseenter, and the hover-triggered popover never opens (seen: hovering right after clicking sync always gave `aria-expanded="false"`, unchanged over 33 retries in 15s). Moving away makes this hover a real "move in".
    await page.mouse.move(0, 0);
    await pill.hover();
    await expect(pill).toHaveAttribute("aria-expanded", "true", { timeout: 2_000 });
  }).toPass({ timeout: 20_000 });
}

/**
 * Clicks the header sync pill = runs a whole round (see sync-status.tsx's StatusSegment onClick); `POST /api/sync` has been sent by the time it returns.
 * Repeated clicks don't run an extra round: `useSyncRound`'s `sync()` returns when disabled, and opening a round is itself idempotent, so two real sends get the same round back the second time.
 * Waits only for the request to be sent, not the response body: the request opens the round and enqueues, so the response only means the round opened and jobs were enqueued, not that the consumer is already hitting the upstream;
 * to judge that it is really working, ask the fake upstream whether it got a request (setUpstream hits).
 */
export async function clickSyncPill(page: Page) {
  const pill = page.getByRole("button", { name: /^(Synced|Needs attention|Syncing…)$/ });
  // Why not "click once, wait 3s for the POST": the 3s starts before the click, and after reload the pill appears only once the client has rendered (the shell is zero-data); on the dev server that takes
  // 2.6s at least and longer for cases with page.route. Past 3s, waitForRequest rejects while the click is still pending with nobody catching it, and the unhandled rejection kills the whole test so the outer toPass never retries.
  // The pill sits above the popover content (sync-status.tsx), so a direct click works; that behavior is pinned by e2e/sync-pill.spec.ts.
  await expect(async () => {
    // Promise.all attaches both sides at once: a failure on either side is caught here and handed to toPass for retry, leaving no dangling promise.
    await Promise.all([
      page.waitForRequest((r) => r.url().includes("/api/sync") && r.method() === "POST", {
        timeout: 3_000,
      }),
      pill.click(),
    ]);
  }).toPass({ timeout: 30_000 });
}

/**
 * The runner is serial (one DO, one alarm per job) and the sync job may queue behind price / rate jobs; those hit the fake CoinGecko and return instantly, but the CoinGecko client's own rate gate
 * (a few calls per minute without a key) still spaces each call by about 6 seconds, so the sync job waits ten-odd seconds for its turn in a round.
 */
const UPSTREAM_HIT_TIMEOUT_MS = 45_000;

/** Waits until the fake upstream really starts receiving requests, i.e. the server is working on this round. Use with `setUpstream(request, { hits: 0 })`. */
export async function waitForUpstreamHit(request: APIRequestContext) {
  await expect
    .poll(async () => (await upstream(request)).hits, {
      message: "the fake upstream received no request at all -- the server didn't start this round",
      timeout: UPSTREAM_HIT_TIMEOUT_MS,
    })
    .toBeGreaterThan(0);
}

export interface ExportedSnapshot {
  accountId: string;
  takenAt: number;
  totalUsd: number;
  balances: { amount: number; usdValue: number; kind: string }[];
}

interface ExportedAccount {
  id: string;
  label: string;
}

interface Exported {
  accounts: ExportedAccount[];
  snapshots: ExportedSnapshot[];
}

/**
 * Reads this user's accounts and persisted snapshots back from `/api/export`.
 * Reads the export rather than the UI: it's a stable HTTP endpoint returning the **raw DB values** (quantity, valuation, takenAt), unaffected by formatting, the selected portfolio or collapse state;
 * and "did the sync finish" is exactly "is that row in the DB". Uses `context().request` rather than `page.request` so reads continue after the page closes, which the core case needs.
 */
async function exportData(page: Page): Promise<Exported> {
  const res = await page.context().request.get("/api/export");
  expect(res.ok(), `export failed: ${res.status()}`).toBe(true);
  const records = (await res.text())
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line));
  return {
    accounts: records.filter((r) => r.type === "account"),
    snapshots: records.filter((r) => r.type === "snapshot"),
  };
}

/** The number of snapshots currently persisted for this user. */
export async function snapshotCount(page: Page): Promise<number> {
  return (await exportData(page)).snapshots.length;
}

export async function accountIdByLabel(page: Page, label: string): Promise<string> {
  const { accounts } = await exportData(page);
  const hit = accounts.find((a) => a.label === label);
  if (!hit) throw new Error(`no account named ${label} in the export: ${JSON.stringify(accounts)}`);
  return hit.id;
}

/**
 * Waits until **every** given account has a snapshot meeting the condition, returned in input order.
 * Uses `expect.poll` rather than waiting a duration: returns as soon as the condition holds, and otherwise puts which accounts are still missing in the error, so "none at all" vs "missing the last two"
 * is clear at a glance, the latter being the failure shape the concurrency case must distinguish. One export read per round (not per account): eight accounts would mean eight times the requests while their answers are in the same export.
 */
export async function waitForSnapshots(
  page: Page,
  accountIds: string[],
  predicate: (s: ExportedSnapshot) => boolean,
  message: string,
  timeout = 25_000,
): Promise<ExportedSnapshot[]> {
  let matches: (ExportedSnapshot | undefined)[] = [];
  await expect
    .poll(
      async () => {
        const { snapshots } = await exportData(page);
        matches = accountIds.map((id) => snapshots.find((s) => s.accountId === id && predicate(s)));
        const missing = accountIds.filter((_, i) => !matches[i]);
        return missing.length === 0 ? "matched" : `still missing ${missing.length}: ${missing}`;
      },
      { message, timeout },
    )
    .toBe("matched");
  const found = matches.filter((s): s is ExportedSnapshot => s !== undefined);
  if (found.length !== accountIds.length) throw new Error(message);
  return found;
}

/** A single account's version (the common form of the one above). */
export async function waitForSnapshot(
  page: Page,
  accountId: string,
  predicate: (s: ExportedSnapshot) => boolean,
  message: string,
): Promise<ExportedSnapshot> {
  const [snapshot] = await waitForSnapshots(page, [accountId], predicate, message);
  if (!snapshot) throw new Error(message);
  return snapshot;
}
