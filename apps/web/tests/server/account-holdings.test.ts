import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { floorToHour } from "@/lib/core/portfolio";
import { readAccountHoldingsView } from "./_kit/run";
import { dbFor } from "./db-effect";
import { addManualActivities } from "./manual-fns";

// Archiving seals: the per-account breakdown must include archived accounts, showing the sealed-moment value. Needs real D1 because it
// spans accounts, snapshots, manual synthetic injection and enrichment, which only shows across layers. Outbound is stubbed to throw
// (prices come from snapshots and the local reference layer). Same-fidelity cases live in `portfolio/account-holdings.test.ts` and
// `portfolio/gain.test.ts`; what stays here is cross-chain gain apportionment and manual/synced accounts sharing a token_id.
const USER = "user-account-holdings";

let outbound: string[] = [];

beforeEach(async () => {
  await env.DB.prepare("DELETE FROM user WHERE id = ?").bind(USER).run();
  const now = Date.now();
  await env.DB.prepare(
    "INSERT INTO user (id, name, email, email_verified, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
  )
    .bind(USER, USER, `${USER}@example.com`, 0, now, now)
    .run();
  outbound = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    outbound.push(String(input));
    throw new Error(`this case must not go outbound, but requested ${String(input)}`);
  });
});

afterEach(() => vi.restoreAllMocks());

const evmAccount = (label: string, address: string) =>
  dbFor(USER).accounts.create({
    connectorId: "evm",
    platform: "evm:1",
    label,
    creds: JSON.stringify({ address }),
  });

// Gain (end-to-end subtraction) and live repricing now run in the browser's `accountRowsFromRaw`; the server ships only raw atoms.
// `readAccountHoldingsView` wires the two halves together, so assertions see the final view, value for value as the production read path.
const rowsByLabel = async () => {
  const view = await readAccountHoldingsView(USER);
  return {
    view,
    of: (label: string) => view.rows.find((r) => r.account.label === label),
  };
};

describe("per-account breakdown and archiving", () => {
  it("archived account has no snapshot (archived before ever syncing) -> falls back to empty, but its row remains", async () => {
    const never = await evmAccount("NeverSynced", "0xnever");
    await dbFor(USER).accounts.setArchived(never.id, true);

    const { of } = await rowsByLabel();

    expect(of("NeverSynced")).toBeDefined();
    expect(of("NeverSynced")?.totalUsd).toBe(0);
    expect(of("NeverSynced")?.balances).toEqual([]);
  });
});

describe("live repricing: account page and home use the same basis", () => {
  // Account page (list + drawer) must not take the snapshot-frozen totalUsd / usdValue, which show stale prices and a flat $0 24h change.
  // Active accounts now go row by row through `liveValue` (same basis as home's `deriveLiveAccountTotals`); marked-to-market rows use the reference layer's live price.
  const seedPrice = (tokenId: string, unitPrice: number) =>
    env.DB.prepare("UPDATE tokens SET unit_price = ?, price_as_of = ? WHERE id = ?")
      .bind(unitPrice, Date.now(), tokenId)
      .run();

  it("active accounts reprice from the reference layer's live price, not the last sync's frozen value", async () => {
    const btc = await dbFor(USER).transfer.importToken({ symbol: "BTC", name: "Bitcoin" }, [
      { namer: "coingecko", localName: "issued:bitcoin" },
    ]);
    const acc = await evmAccount("Repriced", "0xreprice");
    // Snapshot frozen at $100 (1 BTC x the price at sync); marked-to-market rows write no selfPrice -> read time always uses the source price.
    await dbFor(USER).snapshots.write(acc.id, {
      takenAt: Date.now(),
      totalUsd: 100,
      balances: [{ amount: 1, usdValue: 100, kind: "spot", platform: "evm:1", tokenId: btc }],
    });
    await seedPrice(btc, 150); // reference layer live price rises to $150

    const { of } = await rowsByLabel();
    const row = of("Repriced");
    // Frozen totalUsd would give 100; repricing gives $150 at both account level and row level.
    expect(row?.totalUsd).toBeCloseTo(150, 4);
    expect(row?.balances[0]?.usdValue).toBeCloseTo(150, 4);
  });

  it("archived accounts are not repriced: still show the frozen value from the sealing moment", async () => {
    const btc = await dbFor(USER).transfer.importToken({ symbol: "BTC", name: "Bitcoin" }, [
      { namer: "coingecko", localName: "issued:bitcoin-sealed" },
    ]);
    const acc = await evmAccount("Sealed", "0xsealed");
    await dbFor(USER).snapshots.write(acc.id, {
      takenAt: Date.now(),
      totalUsd: 100,
      balances: [{ amount: 1, usdValue: 100, kind: "spot", platform: "evm:1", tokenId: btc }],
    });
    await seedPrice(btc, 150);
    await dbFor(USER).accounts.setArchived(acc.id, true);

    const { of } = await rowsByLabel();
    // The live price 150 doesn't move it: sealed = the snapshot-moment value, not repriced.
    expect(of("Sealed")?.totalUsd).toBeCloseTo(100, 4);
    expect(of("Sealed")?.balances[0]?.usdValue).toBeCloseTo(100, 4);
  });

  it("24h change uses live prices on the frontend (not frozen value = start point -> always $0)", async () => {
    const btc = await dbFor(USER).transfer.importToken({ symbol: "BTC", name: "Bitcoin" }, [
      { namer: "coingecko", localName: "issued:bitcoin-gain" },
    ]);
    const acc = await evmAccount("LiveGain", "0xlivegain");
    const DAY = 24 * 60 * 60 * 1000;
    const now = floorToHour(Date.now());
    // The two snapshots' frozen values are equal ($100) 24h ago and now, so subtracting the two ends would always give $0.
    for (const t of [now - DAY, now] as const) {
      await dbFor(USER).snapshots.write(acc.id, {
        takenAt: t,
        totalUsd: 100,
        balances: [{ amount: 1, usdValue: 100, kind: "spot", platform: "evm:1", tokenId: btc }],
      });
    }
    await seedPrice(btc, 150); // live price $150 -> current 150 - start 100 = +50

    const { of } = await rowsByLabel();
    expect(of("LiveGain")?.gain24h?.amount).toBeCloseTo(50, 4);
  });
});

describe("account row 24h gain", () => {
  // Same assembly as token rows, but lines accumulate per account rather than per coin. Real D1 since it spans accounts, snapshot
  // history and enrichment; in particular "archived accounts get undefined (shouldn't have one), not null (can't compute)" only shows end to end.

  const withHistory = async (label: string, address: string, then: number, nowValue: number) => {
    const btc = await dbFor(USER).transfer.importToken({ symbol: "BTC", name: "Bitcoin" }, [
      { namer: "coingecko", localName: `issued:${address}` },
    ]);
    const acc = await dbFor(USER).accounts.create({
      connectorId: "evm",
      platform: "evm:1",
      label,
      creds: JSON.stringify({ address }),
    });
    const now = floorToHour(Date.now());
    const DAY = 24 * 60 * 60 * 1000;
    // Snapshot 24 hours ago (baseline)
    await dbFor(USER).snapshots.write(acc.id, {
      takenAt: now - DAY,
      totalUsd: then,
      balances: [{ amount: 1, usdValue: then, kind: "spot", platform: "evm:1", tokenId: btc }],
    });
    // Latest snapshot (now)
    await dbFor(USER).snapshots.write(acc.id, {
      takenAt: now,
      totalUsd: nowValue,
      balances: [{ amount: 1, usdValue: nowValue, kind: "spot", platform: "evm:1", tokenId: btc }],
    });
    return acc;
  };

  it("whole path makes no outbound calls", async () => {
    await withHistory("Quiet", "0xd", 100, 110);
    await rowsByLabel();
    expect(outbound).toEqual([]);
  });
});

describe("drawer spot rows' per-coin gain", () => {
  const DAY = 24 * 60 * 60 * 1000;

  it("one coin spread across several chains -- rows sum to the coin's total gain, not each row claiming all of it", async () => {
    const usdc = await dbFor(USER).transfer.importToken({ symbol: "USDC", name: "USD Coin" }, [
      { namer: "coingecko", localName: "issued:usd-coin" },
    ]);
    const acc = await dbFor(USER).accounts.create({
      connectorId: "evm",
      platform: "evm:1",
      label: "Multi",
      creds: JSON.stringify({ address: "0xmulti" }),
    });
    // Quantity fixed, only market value changes: a changing quantity would be an "add position" whose gain is 0 under the
    // flow-excluding basis (the algorithm is right; the fixture is what could be wrong).
    const legs = (a: number, b: number) => [
      { amount: 60, usdValue: a, kind: "spot" as const, platform: "evm:1", tokenId: usdc },
      { amount: 40, usdValue: b, kind: "spot" as const, platform: "evm:8453", tokenId: usdc },
    ];
    const now = floorToHour(Date.now());
    await dbFor(USER).snapshots.write(acc.id, {
      takenAt: now - DAY,
      totalUsd: 100,
      balances: legs(60, 40),
    });
    await dbFor(USER).snapshots.write(acc.id, {
      takenAt: now,
      totalUsd: 110,
      balances: legs(66, 44),
    });

    const { of } = await rowsByLabel();
    const rows = of("Multi")?.balances ?? [];
    expect(rows).toHaveLength(2);
    const amounts = rows.map((b) => b.gain24h?.amount ?? 0);
    // The coin earned 10 in total; two rows split 66/110 and 44/110 -> 6 and 4
    expect(amounts.reduce((s, x) => s + x, 0)).toBeCloseTo(10, 4);
    expect(Math.max(...amounts)).toBeCloseTo(6, 4);
    // If every row claimed all of it, both would be 10, summing to 20
    expect(Math.max(...amounts)).not.toBeCloseTo(10, 2);
  });
});

describe("manual account drawer spot rows", () => {
  // The drawer header showed -$1,524.85 while its only BTC row below showed `—`: same account, same coin, two numbers fighting.
  // Account-level and per-coin use the same raw input and assembly, so one shouldn't compute while the other doesn't.
  const DAY = 24 * 60 * 60 * 1000;
  const localBtc = { symbol: "BTC", unitPrice: 100 };

  it("when the account header computes, the row below it computes too -- same source", async () => {
    const acc = await dbFor(USER).accounts.create({
      connectorId: "manual",
      label: "M1",
      creds: JSON.stringify({ tokens: "[]" }),
    });
    await addManualActivities(USER, acc.id, [
      { token: localBtc, kind: "add", amount: 2, occurredAt: Date.now() - 3 * DAY, price: 100 },
    ]);

    const { of } = await rowsByLabel();
    const row = of("M1");
    expect(row?.gain24h).not.toBeUndefined();
    expect(row?.gain24h).not.toBeNull(); // account header computes
    expect(row?.balances).toHaveLength(1);
    // This is the contradiction seen in the browser
    expect(row?.balances[0].gain24h).not.toBeNull();
  });
});

describe("replicating real-data shape: manual and synced accounts mixed together", () => {
  // The header-has-a-number / spot-row-shows-`—` contradiction didn't reproduce in the simpler cases. Real data adds three things, all given here:
  //   1. several synced accounts with snapshots, one holding the same coin (user-level token_id -> the same id)
  //   2. snapshots at 29.9h / 17.5h; the end-to-end subtraction takes the 29.9h one as the start (still within the 7d window)
  //   3. manual ledger activity outside the window (128h ago), so only the synthetic start folded from the ledger at the window start works
  const DAY = 24 * 60 * 60 * 1000;
  const HOUR = 3600_000;
  const localBtc = { symbol: "BTC", unitPrice: 63921 };

  // Two manual accounts sharing one token_id are covered too: each row stays separate and computes.
  it("synced accounts use the nearest in-window start (29.9h); manual account header and spot row both compute", async () => {
    const now = Date.now();
    // 1. synced accounts: two snapshots, 29.9h (start) and 17.5h (now)
    const btc = await dbFor(USER).transfer.importToken({ symbol: "BTC", name: "Bitcoin" }, [
      { namer: "coingecko", localName: "issued:bitcoin" },
    ]);
    const synced = await evmAccount("Synced", "0xsynced");
    for (const [t, v] of [
      [now - 29.9 * HOUR, 900_000],
      [now - 17.5 * HOUR, 958_000],
    ] as const) {
      await dbFor(USER).snapshots.write(synced.id, {
        takenAt: t,
        totalUsd: v,
        balances: [{ amount: 14, usdValue: v, kind: "spot", platform: "evm:1", tokenId: btc }],
      });
    }

    // 2. two manual accounts, activity 128h ago, holding the same coin
    const manuals: string[] = [];
    for (const label of ["xxx", "a"]) {
      const m = await dbFor(USER).accounts.create({
        connectorId: "manual",
        label,
        creds: JSON.stringify({ tokens: "[]" }),
      });
      await addManualActivities(USER, m.id, [
        { token: localBtc, kind: "add", amount: 2, occurredAt: now - 128 * HOUR, price: 63921 },
      ]);
      manuals.push(label);
    }

    const { of } = await rowsByLabel();

    // Synced account: start = the 29.9h one (900k), now = the 17.5h one (958k) -> subtracting the two ends gives +58k.
    expect(of("Synced")?.gain24h?.amount).toBeCloseTo(58_000, 4);

    for (const label of manuals) {
      const row = of(label);
      // the drawer header's number
      expect(row?.gain24h, `${label} account header`).not.toBeNull();
      expect(row?.gain24h, `${label} account header`).not.toBeUndefined();
      // the row below it -- the `—` shown in the browser
      expect(row?.balances, `${label} has a holding row`).toHaveLength(1);
      expect(row?.balances[0]?.gain24h, `${label} spot row`).not.toBeNull();
      expect(row?.balances[0]?.gain24h, `${label} spot row`).not.toBeUndefined();
    }
  });

  it("manual and synced accounts hold the same token_id -- the two sides' lines don't mix", async () => {
    const now = floorToHour(Date.now());
    const btc = await dbFor(USER).transfer.importToken({ symbol: "BTC", name: "Bitcoin" }, [
      { namer: "coingecko", localName: "issued:bitcoin" },
    ]);
    const synced = await evmAccount("S2", "0xs2");
    await dbFor(USER).snapshots.write(synced.id, {
      takenAt: now - DAY,
      totalUsd: 100,
      balances: [{ amount: 1, usdValue: 100, kind: "spot", platform: "evm:1", tokenId: btc }],
    });
    await dbFor(USER).snapshots.write(synced.id, {
      takenAt: now,
      totalUsd: 110,
      balances: [{ amount: 1, usdValue: 110, kind: "spot", platform: "evm:1", tokenId: btc }],
    });
    const m = await dbFor(USER).accounts.create({
      connectorId: "manual",
      label: "M9",
      creds: JSON.stringify({ tokens: "[]" }),
    });
    await addManualActivities(USER, m.id, [
      { token: localBtc, kind: "add", amount: 2, occurredAt: now - 128 * HOUR, price: 63921 },
    ]);

    const { of } = await rowsByLabel();
    // A synced account's line has a real baseline (exactly 24h) -> computes; the manual one goes through the ledger -> computes too. Independent.
    expect(of("S2")?.balances[0]?.gain24h).not.toBeNull();
    expect(of("M9")?.balances[0]?.gain24h).not.toBeNull();
  });
});
