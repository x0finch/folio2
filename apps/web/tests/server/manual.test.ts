import { env } from "cloudflare:test";
import { FIAT_NAMER, tokenTicket } from "@folio/oracle-basic";
import { tokenRef } from "@folio/oracle-ref";
import { beforeEach, describe, expect, it } from "vitest";
import { deriveAmount } from "@/lib/core/manual";
import { NAMER } from "@/lib/server/oracle";
import { dbFor } from "./db-effect";
import { createAccountFor, createManualAccount } from "./manual-fns";
import { ticketOf } from "./ticket";

// Real D1 integration for manual account creation (server orchestration jsdom unit tests can't reach). Storage isn't
// isolated per test, so beforeEach resets (deleting the user cascades accounts/tokens/activities).
const USER = "user-manual-it";

async function resetUser(): Promise<void> {
  await env.DB.prepare("DELETE FROM user WHERE id = ?").bind(USER).run(); // cascade → accounts/tokens → activity
  const now = Date.now();
  await env.DB.prepare(
    "INSERT INTO user (id, name, email, email_verified, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
  )
    .bind(USER, USER, `${USER}@example.com`, 0, now, now)
    .run();
}

beforeEach(resetUser);

// The account's holdings (definitions + quantities folded from the ledger): the only source of truth.
async function holdings(accountId: string) {
  const rows = await dbFor(USER).manual.listHoldings(accountId, NAMER);
  return Promise.all(
    rows.map(async (r) => ({
      symbol: r.symbol,
      ref: r.ref,
      amount: deriveAmount(await dbFor(USER).manual.listActivityByToken(accountId, r.id)),
    })),
  );
}

// The account's creds must no longer hold holding data.
async function credsOf(accountId: string): Promise<Record<string, unknown>> {
  const raw = await dbFor(USER).accounts.getRawCreds(accountId);
  return JSON.parse(raw ?? "{}");
}

describe("createManualAccount (D1 round-trip)", () => {
  it("pick coin -> records declaration -> one opening set activity", async () => {
    const tokens = JSON.stringify([
      { symbol: "BTC", unitPrice: "64000", ticket: ticketOf("bitcoin"), amount: "0.5" },
    ]);
    const account = await createManualAccount(USER, "My BTC", tokens);

    expect(await holdings(account.id)).toEqual([
      { symbol: "BTC", ref: `${NAMER}/issued:bitcoin`, amount: 0.5 },
    ]);
  });

  // A picked coin's ticket decodes to a ref that anchors the mint directly: no mapping lookup, no symbol guessing.
  it("picked coin -> the ref decoded from the ticket sets identity", async () => {
    const account = await createManualAccount(
      USER,
      "M",
      JSON.stringify([{ symbol: "XBT", unitPrice: "1", amount: "1", ticket: ticketOf("bitcoin") }]),
    );
    const [h] = await dbFor(USER).manual.listHoldings(account.id, NAMER);
    expect(h.ref).toBe(`${NAMER}/issued:bitcoin`); // even if the symbol was typed as XBT
  });

  // The ticket comes from the network: undecodable means no coin picked (falls back to `manual/custom:<name>`), not a crash or dirty write.
  it("corrupt ticket -> treated as no coin picked, its own row", async () => {
    const account = await createManualAccount(
      USER,
      "M",
      JSON.stringify([{ symbol: "XBT", unitPrice: "1", amount: "1", ticket: "!!!not-base64!!!" }]),
    );
    const [h] = await dbFor(USER).manual.listHoldings(account.id, NAMER);
    expect(h.ref).toBeNull(); // no upstream naming -> its own row, valued at the user's unit price
  });

  // A well-formed ticket from a foreign namer. Tickets are unsigned and `issued` means the namer vouches for it;
  // without checking the namer, mint would fall back to symbol matching and a typed `BTC` would be identified again.
  // BTC is recognizable among candidates, so blocking is observable: blocked = its own row, not blocked = upstream BTC ref.
  it("well-formed ticket but foreign namer -> also treated as no coin picked, no symbol matching", async () => {
    const forged = tokenTicket.encode("evil/issued:whatever");
    const account = await createManualAccount(
      USER,
      "M",
      JSON.stringify([{ symbol: "BTC", unitPrice: "1", amount: "1", ticket: forged }]),
    );
    const [h] = await dbFor(USER).manual.listHoldings(account.id, NAMER);
    expect(h.ref).toBeNull();
  });

  // creds' `tokens` field is an empty shell: it declares the create-form input, not where holdings are stored.
  it("holding data is no longer written into creds", async () => {
    const account = await createManualAccount(
      USER,
      "M",
      JSON.stringify([{ symbol: "BTC", unitPrice: "1", amount: "1" }]),
    );
    expect((await credsOf(account.id)).tokens).toBe("[]");
  });

  it("rejects an empty tokens array (form always sends one; z.array admits [])", async () => {
    await expect(createManualAccount(USER, "M", "[]")).rejects.toThrow();
  });

  // End to end: fiat picked -> ticket carries `fiat/issued:USD` -> mintHolding decodes it (namer set includes fiat) -> mint builds the
  // canonical fiat row. Identity lives under the fiat namer (coingecko's is always empty). Reverting manual.ts's decode to NAMER-only turns this red.
  it("fiat picked -> ticket decodes to fiat identity -> canonical fiat row built", async () => {
    const account = await createManualAccount(
      USER,
      "Cash",
      JSON.stringify([
        {
          symbol: "USD",
          unitPrice: "1",
          amount: "500",
          ticket: tokenTicket.encode(tokenRef.issued(FIAT_NAMER, "USD")),
        },
      ]),
    );
    const [underFiat] = await dbFor(USER).manual.listHoldings(account.id, FIAT_NAMER);
    expect(underFiat.symbol).toBe("USD");
    expect(underFiat.ref).toBe("fiat/issued:USD");
    // Quantity persisted; the coingecko namer has no ref (fiat doesn't link upstream).
    expect(await holdings(account.id)).toEqual([{ symbol: "USD", ref: null, amount: 500 }]);
  });

  it("no coin picked -> that namer's ref is empty (unrecognized), still persisted", async () => {
    const account = await createManualAccount(
      USER,
      "M",
      JSON.stringify([{ symbol: "PRIVATETOKEN", unitPrice: "3200", amount: "2" }]),
    );
    expect(await holdings(account.id)).toEqual([{ symbol: "PRIVATETOKEN", ref: null, amount: 2 }]);
  });
});

// createAccountFor dispatch: manual is validated through the shared validateAccountCreds (provider's manualToken schema)
// and dispatched to ledger creation.
describe("createAccountFor (manual: shared validate + dispatch)", () => {
  it("rejects manual creds missing symbol (runs through validateAccountCreds)", async () => {
    await expect(
      createAccountFor(USER, "manual", "M", {
        tokens: JSON.stringify([{ unitPrice: "1", amount: "1" }]),
      }),
    ).rejects.toThrow();
  });

  it("rejects when tokens is absent", async () => {
    await expect(createAccountFor(USER, "manual", "M", {})).rejects.toThrow();
  });

  it("valid input -> account + holding declaration + opening activity", async () => {
    const account = await createAccountFor(USER, "manual", "My BTC", {
      tokens: JSON.stringify([
        { symbol: "BTC", unitPrice: "64000", amount: "0.5", ticket: ticketOf("bitcoin") },
      ]),
    });
    expect(await holdings(account.id)).toEqual([
      { symbol: "BTC", ref: `${NAMER}/issued:bitcoin`, amount: 0.5 },
    ]);
  });
});

// Quantities are always computed on read, so there is no "forgot to rerun materialization -> stale" failure mode.
describe("quantities change immediately with the ledger (no materialization)", () => {
  it("after one more activity, the read quantity is new at once", async () => {
    const account = await createManualAccount(
      USER,
      "M",
      JSON.stringify([{ symbol: "BTC", unitPrice: "60000", amount: "1" }]),
    );
    const [h] = await dbFor(USER).manual.listHoldings(account.id, NAMER);
    await dbFor(USER).manual.recordActivity(account.id, h.id, {
      kind: "add",
      amount: 0.5,
      occurredAt: Date.now() + 1,
    });
    expect((await holdings(account.id))[0].amount).toBe(1.5);
  });
});
