import { env } from "cloudflare:test";
import type { SnapshotWithBalances } from "@folio/db";
import { beforeEach, describe, expect, it } from "vitest";
import { dbFor } from "./db-effect";
import { createManualAccount, injectManualSnapshots, manualBalancesForWarm } from "./manual-fns";
import { ticketOf } from "./ticket";

// Server-side integration: manual accounts write no snapshots and their current value is synthesized from creds. Real D1 (Miniflare); storage is not isolated per test, so beforeEach resets.
const USER = "user-manual-t2";

async function resetUser(): Promise<void> {
  await env.DB.prepare("DELETE FROM user WHERE id = ?").bind(USER).run();
  const now = Date.now();
  await env.DB.prepare(
    "INSERT INTO user (id, name, email, email_verified, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
  )
    .bind(USER, USER, `${USER}@example.com`, 0, now, now)
    .run();
}

beforeEach(resetUser);

// Which upstream coin a synthesized balance maps to is read back via its token_id from token_refs' coingecko namer: `issued:<coinId>` if a coin was picked, else null.
async function coingeckoRefOf(tokenId: string | null | undefined): Promise<string | null> {
  if (!tokenId) return null;
  const row = await env.DB.prepare(
    "SELECT local_name AS n FROM token_refs WHERE user_id = ? AND namer = 'coingecko' AND token_id = ?",
  )
    .bind(USER, tokenId)
    .first<{ n: string }>();
  return row?.n ?? null;
}

describe("injectManualSnapshots (D1 round-trip)", () => {
  it("injects a synthesized current item for a manual account (cold cache -> falls back to unitPrice)", async () => {
    const account = await createManualAccount(
      USER,
      "My BTC",
      JSON.stringify([
        { symbol: "BTC", unitPrice: "64000", ticket: ticketOf("bitcoin"), amount: "0.5" },
      ]),
    );
    const accounts = await dbFor(USER).accounts.list();
    const byAccount = new Map<string, SnapshotWithBalances>();
    await injectManualSnapshots(USER, accounts, byAccount, 1_700_000_000_000);

    const synth = byAccount.get(account.id);
    expect(synth).toBeDefined();
    expect(synth?.balances.map((b) => b.amount)).toEqual([0.5]);
    // Token cache is empty in tests -> enrich has no price -> falls back to amount x unitPrice = 0.5 x 64000.
    expect(synth?.snapshot.totalUsd).toBe(32000);
    expect(synth?.balances[0].selfPrice).toBeNull();
    // Bitcoin was picked -> the row's token resolves to coingecko's bitcoin (identity lives on the Token).
    expect(await coingeckoRefOf(synth?.balances[0].tokenId)).toBe("issued:bitcoin");
  });

  // Seeds a market price for an already-minted per-user token (coingecko ref `issued:<coinId>`), as after a
  // sync's `prices` job; the read path's enrich takes it from the user's `tokens` row (cache-only, no network).
  async function warmUserPrice(coinId: string, unitPrice: number): Promise<void> {
    const row = await env.DB.prepare(
      "SELECT token_id FROM token_refs WHERE user_id = ? AND namer = 'coingecko' AND local_name = ?",
    )
      .bind(USER, `issued:${coinId}`)
      .first<{ token_id: string }>();
    if (!row) throw new Error(`no minted token for coingecko/issued:${coinId}`);
    await env.DB.prepare(
      "UPDATE tokens SET unit_price = ?, price_as_of = ?, price_expires_at = ? WHERE user_id = ? AND id = ?",
    )
      .bind(unitPrice, 1, 4_000_000_000_000, USER, row.token_id)
      .run();
  }

  // A hand-typed symbol must never pick up someone else's price: a token with no picked coin has an empty
  // `ref` and never links to CoinGecko, so enrich cannot reach any real coin's price. The own price always wins.
  it("no coin picked -> uses their unit price, even if a real USDC with a market price exists", async () => {
    // A real USDC (picked + priced) in the same user's DB proves isolation comes from token_id, not from nothing to fetch.
    await createManualAccount(
      USER,
      "Picked USDC",
      JSON.stringify([
        { symbol: "USDC", unitPrice: "1", amount: "1", ticket: ticketOf("usd-coin") },
      ]),
    );
    await warmUserPrice("usd-coin", 1);
    const account = await createManualAccount(
      USER,
      "My USDC",
      JSON.stringify([{ symbol: "USDC", unitPrice: "777", amount: "10" }]),
    );
    const accounts = await dbFor(USER).accounts.list();
    const byAccount = new Map<string, SnapshotWithBalances>();
    await injectManualSnapshots(USER, accounts, byAccount, 1_700_000_000_000);

    const synth = byAccount.get(account.id);
    // No coin picked -> the token has no coingecko namer (it is named manual/custom:USDC), so it can't reach the real USDC price.
    expect(await coingeckoRefOf(synth?.balances[0].tokenId)).toBeNull();
    expect(synth?.snapshot.totalUsd).toBe(7770); // 10 x 777, not 10 x 1
  });

  // Control: with a coin picked and a cached price the market price must win, else the case above passes trivially.
  it("coin picked + cached price -> uses the market price, not their unit price", async () => {
    const account = await createManualAccount(
      USER,
      "Picked USDC",
      JSON.stringify([
        { symbol: "USDC", unitPrice: "777", amount: "10", ticket: ticketOf("usd-coin") },
      ]),
    );
    await warmUserPrice("usd-coin", 1); // seed the price after mint (price facet is on the per-user token row)
    const accounts = await dbFor(USER).accounts.list();
    const byAccount = new Map<string, SnapshotWithBalances>();
    await injectManualSnapshots(USER, accounts, byAccount, 1_700_000_000_000);

    const synth = byAccount.get(account.id);
    expect(await coingeckoRefOf(synth?.balances[0].tokenId)).toBe("issued:usd-coin");
    expect(synth?.snapshot.totalUsd).toBe(10); // 10 × 1
  });

  it("non-manual accounts are not injected", async () => {
    const btc = await dbFor(USER).accounts.create({
      connectorId: "bitcoin",
      label: "BTC wallet",
      creds: null,
    });
    const accounts = await dbFor(USER).accounts.list();
    const byAccount = new Map<string, SnapshotWithBalances>();
    await injectManualSnapshots(USER, accounts, byAccount);
    expect(byAccount.has(btc.id)).toBe(false);
  });
});

// Synthesized-balance collector for price refresh (heldTokenIdsOf in `prices/job.ts`, same source as the injector's enrich gate).
describe("manualBalancesForWarm", () => {
  it("returns synthesized balances of active manual accounts, excluding archived", async () => {
    await createManualAccount(
      USER,
      "Active",
      JSON.stringify([
        { symbol: "BTC", unitPrice: "60000", ticket: ticketOf("bitcoin"), amount: "1" },
      ]),
    );
    const archived = await createManualAccount(
      USER,
      "Archived",
      JSON.stringify([
        { symbol: "ETH", unitPrice: "3000", ticket: ticketOf("ethereum"), amount: "2" },
      ]),
    );
    await dbFor(USER).accounts.setArchived(archived.id, true);

    const accounts = await dbFor(USER).accounts.list(); // includes archived
    const balances = await manualBalancesForWarm(USER, accounts);
    // Only active accounts' coins (BTC), not the archived account's (ETH). Identity goes by token_id.
    expect(balances).toHaveLength(1);
    expect(await coingeckoRefOf(balances[0].tokenId)).toBe("issued:bitcoin");
  });
});
