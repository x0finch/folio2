import { beforeEach, describe, expect, it } from "vitest";
import {
  CreateActivitiesInput,
  handleCreateManualActivities,
} from "@/lib/server/manual-activities/create";
import { handleGetManualAccount } from "@/lib/server/manual-tokens/get-account";
import { blockOutbound } from "../_kit/outbound";
import { call } from "../_kit/run";
import { HOUR, seedManualAccount } from "../_kit/seed";
import { freshUser } from "../_kit/user";

describe("manual-activities/create", () => {
  // Overdraw is a return value (`{ ok: false, reason: "overdraw" }`), not a failure: use `call`.
  const USER = "h-mact-create";

  // Base time must be relative to (after) the opening entry, which `seedManualAccount` stamps with
  // `Date.now()`; a hardcoded past time would sort before it and zero the holding.
  let T0 = 0;
  const at = (hours: number) => T0 + hours * HOUR;

  const draft = (
    symbol: string,
    kind: "add" | "reduce" | "set",
    amount: number,
    occurredAt: number,
  ) => ({ token: { symbol, unitPrice: 1 }, kind, amount, occurredAt });

  const detail = (accountId: string) => call(USER, handleGetManualAccount({ accountId }));

  const amountOf = async (accountId: string, symbol: string) => {
    const d = await detail(accountId);
    return d.tokens.find((t) => t.symbol === symbol)?.amount;
  };

  beforeEach(async () => {
    blockOutbound();
    await freshUser(USER);
    T0 = Date.now() + HOUR; // safely after the opening entry
  });

  describe("createManualActivities", () => {
    it("three drafts in one submit → all stored, holding derived from them", async () => {
      const acc = await seedManualAccount(USER, "手记", {
        symbol: "BTC",
        unitPrice: 50_000,
        amount: 10,
      });

      const out = await call(
        USER,
        handleCreateManualActivities({
          accountId: acc.id,
          drafts: [
            draft("BTC", "add", 1, at(7)),
            draft("BTC", "add", 2, at(8)),
            draft("BTC", "reduce", 3, at(9)),
          ],
        }),
      );

      expect(out).toEqual({ ok: true });
      expect(await amountOf(acc.id, "BTC")).toBe(10);
      expect((await detail(acc.id)).activities.length).toBe(4); // opening entry + three
    });

    it("token already declared on the account → reused, no duplicate", async () => {
      const acc = await seedManualAccount(USER, "手记", { symbol: "BTC", unitPrice: 1, amount: 1 });

      await call(
        USER,
        handleCreateManualActivities({
          accountId: acc.id,
          drafts: [draft("BTC", "add", 5, at(10))],
        }),
      );

      const d = await detail(acc.id);
      expect(d.tokens.filter((t) => t.symbol === "BTC")).toHaveLength(1);
      expect(d.tokens[0].amount).toBe(6);
    });

    it("a set (calibration) → holding becomes exactly that amount", async () => {
      const acc = await seedManualAccount(USER, "手记", { symbol: "BTC", unitPrice: 1, amount: 7 });

      await call(
        USER,
        handleCreateManualActivities({
          accountId: acc.id,
          drafts: [draft("BTC", "set", 2, at(10))],
        }),
      );

      expect(await amountOf(acc.id, "BTC")).toBe(2);
    });

    it("add, set, then reduce → applied in order; reduce subtracts from the set amount", async () => {
      const acc = await seedManualAccount(USER, "手记", { symbol: "BTC", unitPrice: 1, amount: 1 });

      const out = await call(
        USER,
        handleCreateManualActivities({
          accountId: acc.id,
          drafts: [
            draft("BTC", "add", 100, at(7)),
            draft("BTC", "set", 5, at(8)),
            draft("BTC", "reduce", 4, at(9)),
          ],
        }),
      );

      expect(out).toEqual({ ok: true });
      expect(await amountOf(acc.id, "BTC")).toBe(1);
    });

    it("second of three overdraws → none written (atomic)", async () => {
      const acc = await seedManualAccount(USER, "手记", { symbol: "BTC", unitPrice: 1, amount: 1 });
      const before = (await detail(acc.id)).activities.length;

      const out = await call(
        USER,
        handleCreateManualActivities({
          accountId: acc.id,
          drafts: [
            draft("BTC", "add", 1, at(7)),
            draft("BTC", "reduce", 999, at(8)),
            draft("BTC", "add", 1, at(9)),
          ],
        }),
      );

      expect(out).toEqual({ ok: false, reason: "overdraw", symbol: "BTC" });
      expect((await detail(acc.id)).activities.length).toBe(before);
      expect(await amountOf(acc.id, "BTC")).toBe(1);
    });

    it("reduce beyond holding → names the token, never goes negative", async () => {
      const acc = await seedManualAccount(USER, "手记", { symbol: "BTC", unitPrice: 1, amount: 2 });

      const out = await call(
        USER,
        handleCreateManualActivities({
          accountId: acc.id,
          drafts: [draft("BTC", "reduce", 5, at(10))],
        }),
      );

      expect(out).toEqual({ ok: false, reason: "overdraw", symbol: "BTC" });
      expect(await amountOf(acc.id, "BTC")).toBe(2);
    });

    it("same batch submitted twice (double click) → activities doubled, not deduped", async () => {
      // Pins current behaviour: no idempotency key, so a double submit is two batches.
      const acc = await seedManualAccount(USER, "手记", { symbol: "BTC", unitPrice: 1, amount: 0 });
      const body = { accountId: acc.id, drafts: [draft("BTC", "add", 1, at(10))] };

      await call(USER, handleCreateManualActivities(body));
      await call(USER, handleCreateManualActivities(body));

      expect(await amountOf(acc.id, "BTC")).toBe(2);
    });

    it("future occurredAt → schema rejects", () => {
      // A future buy would lift the curve's right edge with assets that don't exist yet. Small client
      // clock skew is tolerated (see tests/occurred-at.test.ts).
      const future = { ...draft("BTC", "add", 1, 0), occurredAt: Date.now() + 24 * 3600_000 };

      expect(CreateActivitiesInput.safeParse({ accountId: "a", drafts: [future] }).success).toBe(
        false,
      );
    });

    it("empty drafts / negative amount / empty symbol → schema rejects", () => {
      expect(CreateActivitiesInput.safeParse({ accountId: "a", drafts: [] }).success).toBe(false);
      expect(
        CreateActivitiesInput.safeParse({
          accountId: "a",
          drafts: [
            { token: { symbol: "BTC", unitPrice: 1 }, kind: "add", amount: -1, occurredAt: 0 },
          ],
        }).success,
      ).toBe(false);
      expect(
        CreateActivitiesInput.safeParse({
          accountId: "a",
          drafts: [{ token: { symbol: "", unitPrice: 1 }, kind: "add", amount: 1, occurredAt: 0 }],
        }).success,
      ).toBe(false);
    });
  });
});
