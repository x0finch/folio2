import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readAccountHoldingsView } from "./_kit/run";
import { dbFor } from "./db-effect";
import { createManualAccount, sealManualAccount } from "./manual-fns";
import { ticketOf } from "./ticket";

// Archiving seals: manual accounts never write snapshots, so archiving computes the ledger once and writes one real snapshot.
// Real D1 throughout; outbound is stubbed to throw since sealing prices from the local reference cache (falling back to the user's own price).
// Curve cases live in `accounts/archive.cases.ts` and `accounts/history.cases.ts`.
const USER = "user-archive-seal";

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
    throw new Error(`sealing must not go outbound, but requested ${String(input)}`);
  });
});

afterEach(() => vi.restoreAllMocks());

const manualWithBtc = (label = "M") =>
  createManualAccount(
    USER,
    label,
    JSON.stringify([{ symbol: "BTC", unitPrice: "100", amount: "2", ticket: ticketOf("bitcoin") }]),
  );

describe("archiving a manual account writes a sealed snapshot", () => {
  // Manual never writes snapshots, so any snapshot here was written by sealing.
  it("after sealing: one more row in the DB, amount taken from the ledger", async () => {
    const account = await manualWithBtc();

    const sealed = await sealManualAccount(USER, account, 1_700_000_000_000);

    expect(sealed).toBe(true);
    const snaps = await dbFor(USER).snapshots.listByAccount(account.id);
    expect(snaps).toHaveLength(1);
    expect(snaps[0].takenAt).toBe(1_700_000_000_000);
    // 2 units x own price 100 (reference cache is cold, so the live price falls back to the own price)
    expect(snaps[0].totalUsd).toBe(200);
    expect(outbound).toEqual([]);
  });

  it("non-manual accounts get none -- they already have snapshots", async () => {
    const account = await dbFor(USER).accounts.create({
      connectorId: "evm",
      platform: "evm:1",
      label: "Wallet",
      creds: JSON.stringify({ address: "0xabc" }),
    });

    expect(await sealManualAccount(USER, account)).toBe(false);
    expect(await dbFor(USER).snapshots.listByAccount(account.id)).toEqual([]);
  });

  // Seal + archived flag together make the account page show it; walk it end to end.
  it("after seal + archive, the per-account detail includes it with the sealed-moment value", async () => {
    const account = await manualWithBtc();
    await sealManualAccount(USER, account, 1_700_000_000_000);
    await dbFor(USER).accounts.setArchived(account.id, true);

    const view = await readAccountHoldingsView(USER);
    const row = view.rows.find((r) => r.account.id === account.id);

    expect(row?.archivedAt).not.toBeNull();
    expect(row?.totalUsd).toBe(200);
    expect(row?.takenAt).toBe(1_700_000_000_000);
    expect(row?.balances).toHaveLength(1);
  });

  // Unarchiving hands back to the synthesized injection: live numbers, sealed snapshot overwritten (sunk into history).
  it("unarchive -> numbers return to live, the sealed snapshot stays in the DB", async () => {
    const account = await manualWithBtc();
    await sealManualAccount(USER, account, 1_700_000_000_000);
    await dbFor(USER).accounts.setArchived(account.id, true);
    await dbFor(USER).accounts.setArchived(account.id, false);

    const view = await readAccountHoldingsView(USER);
    const row = view.rows.find((r) => r.account.id === account.id);

    expect(row?.archivedAt).toBeNull();
    // injection uses "now", not the sealing moment
    expect(row?.takenAt).not.toBe(1_700_000_000_000);
    // snapshot was not deleted
    expect(await dbFor(USER).snapshots.listByAccount(account.id)).toHaveLength(1);
  });
});
