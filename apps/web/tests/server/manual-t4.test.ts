import { env } from "cloudflare:test";
import { FIAT_NAMER, tokenTicket } from "@folio/oracle-basic";
import { tokenRef } from "@folio/oracle-ref";
import { beforeEach, describe, expect, it } from "vitest";
import { buildOwnedOptions } from "@/components/token-search";
import { dbFor } from "./db-effect";
import {
  addManualActivities,
  createManualAccount,
  editManualActivity,
  loadManualAccountDetail,
} from "./manual-fns";
import { ticketOf } from "./ticket";

// Drawer read path loadManualAccountDetail (token definitions + folded amount + all activities) and fee persistence round-trip.
// Real D1 (Miniflare); storage not isolated per test, so beforeEach resets. The opening set uses Date.now(); later activities use a far-future LATER to sort after it.
const USER = "user-manual-t4";
const LATER = 4_000_000_000_000;

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

async function seedAccount() {
  return createManualAccount(
    USER,
    "M",
    JSON.stringify([
      { symbol: "BTC", unitPrice: "60000", ticket: ticketOf("bitcoin"), amount: "1" },
    ]),
  );
}

describe("loadManualAccountDetail", () => {
  it("returns the token (with DB id + folded amount) + all activities (with tokenId)", async () => {
    const account = await seedAccount();
    await addManualActivities(USER, account.id, [
      {
        token: { symbol: "BTC", unitPrice: 60000, ticket: ticketOf("bitcoin") },
        kind: "add",
        amount: 0.5,
        occurredAt: LATER + 1,
      },
    ]);
    const detail = await loadManualAccountDetail(USER, account.id);

    expect(detail.tokens).toHaveLength(1);
    const [btc] = detail.tokens;
    expect(btc.symbol).toBe("BTC");
    expect(btc.ticket).toBe(ticketOf("bitcoin"));
    expect(btc.amount).toBe(1.5); // opening set 1 + add 0.5
    expect(typeof btc.id).toBe("string");

    // Activities: opening set + add, both on this token.
    expect(detail.activities.map((a) => a.kind).sort()).toEqual(["add", "set"]);
    expect(detail.activities.every((a) => a.tokenId === btc.id)).toBe(true);
  });

  it("empty account (no tokens) -> empty detail", async () => {
    const account = await dbFor(USER).accounts.create({
      connectorId: "manual",
      label: "empty",
      creds: JSON.stringify({ tokens: "[]" }),
    });
    const detail = await loadManualAccountDetail(USER, account.id);
    expect(detail).toEqual({ tokens: [], activities: [] });
  });

  // Fiat holdings' tickets use the fiat namer (coingecko's is always empty); without one the frontend can't
  // get a ticket, so prefill/reselect would mint a custom token instead of the fiat one and ownedOptions would filter it out.
  it("fiat holding: ticket uses the fiat ref and decodes back to the same fiat identity", async () => {
    const eurTicket = tokenTicket.encode(tokenRef.issued(FIAT_NAMER, "EUR"));
    const account = await createManualAccount(
      USER,
      "Cash",
      JSON.stringify([{ symbol: "EUR", unitPrice: "1.15", amount: "1000", ticket: eurTicket }]),
    );
    const detail = await loadManualAccountDetail(USER, account.id);

    expect(detail.tokens).toHaveLength(1);
    const [eur] = detail.tokens;
    expect(eur.symbol).toBe("EUR");
    // Has a ticket (non-null) that decodes to fiat/issued:EUR; reselecting it mints the same token (not custom).
    expect(eur.ticket).not.toBeNull();
    expect(tokenTicket.decode(eur.ticket ?? "", FIAT_NAMER)).toBe("fiat/issued:EUR");
  });

  // End to end: the sidebar "add activity" owned-tokens group = loadManualAccountDetail -> buildOwnedOptions.
  // Pins: (1) anything with a ticket is included (2) sold-out (0 balance) old holdings remain (balance is deliberately ignored) (3) custom (no ticket) excluded.
  it("owned-tokens group: includes sold-out (0 balance) holdings with a ticket, excludes custom (no ticket)", async () => {
    const account = await seedAccount(); // BTC opening set 1 (ticket=bitcoin)
    await addManualActivities(USER, account.id, [
      // BTC fully sold -> balance 0, but still a holding of the account (has activity + ticket).
      {
        token: { symbol: "BTC", unitPrice: 60000, ticket: ticketOf("bitcoin") },
        kind: "reduce",
        amount: 1,
        occurredAt: LATER + 1,
      },
      // Hand-typed custom token (no coin picked -> no ticket).
      { token: { symbol: "PRIV", unitPrice: 5 }, kind: "add", amount: 3, occurredAt: LATER + 2 },
    ]);
    const detail = await loadManualAccountDetail(USER, account.id);
    expect(detail.tokens.find((t) => t.symbol === "BTC")?.amount).toBe(0); // sold out
    expect(detail.tokens.find((t) => t.symbol === "PRIV")?.ticket).toBeNull(); // custom, no ticket

    const owned = buildOwnedOptions(detail.tokens, new Map());
    // BTC (0 balance, has ticket) is present; PRIV (no ticket) is not.
    expect(owned.map((o) => o.symbol)).toEqual(["BTC"]);
  });
});

describe("fee persistence round-trip", () => {
  it("batch-adding activities with fee -> readable after storing", async () => {
    const account = await seedAccount();
    await addManualActivities(USER, account.id, [
      {
        token: { symbol: "BTC", unitPrice: 60000, ticket: ticketOf("bitcoin") },
        kind: "add",
        amount: 0.5,
        occurredAt: LATER + 1,
        price: 60000,
        fee: 12.5,
      },
    ]);
    const detail = await loadManualAccountDetail(USER, account.id);
    const added = detail.activities.find((a) => a.kind === "add");
    expect(added?.fee).toBe(12.5);
    expect(added?.price).toBe(60000);
  });

  it("editing an activity can change fee (including clearing to null)", async () => {
    const account = await seedAccount();
    await addManualActivities(USER, account.id, [
      {
        token: { symbol: "BTC", unitPrice: 60000, ticket: ticketOf("bitcoin") },
        kind: "add",
        amount: 0.5,
        occurredAt: LATER + 1,
        fee: 5,
      },
    ]);
    const added = (await loadManualAccountDetail(USER, account.id)).activities.find(
      (a) => a.kind === "add",
    );
    if (!added) throw new Error("add missing");

    // fee 5 -> 20
    let res = await editManualActivity(USER, added.id, { fee: 20 });
    expect(res.ok).toBe(true);
    expect(
      (await loadManualAccountDetail(USER, account.id)).activities.find((a) => a.id === added.id)
        ?.fee,
    ).toBe(20);

    // clear fee -> null
    res = await editManualActivity(USER, added.id, { fee: null });
    expect(res.ok).toBe(true);
    expect(
      (await loadManualAccountDetail(USER, account.id)).activities.find((a) => a.id === added.id)
        ?.fee,
    ).toBeNull();
  });
});
