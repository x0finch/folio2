import { beforeEach, describe, expect, it } from "vitest";
import { handleCreateManualActivities } from "@/lib/server/manual-activities/create";
import {
  handleUpdateManualActivity,
  UpdateActivityInput,
} from "@/lib/server/manual-activities/update";
import { handleGetManualAccount } from "@/lib/server/manual-tokens/get-account";
import { blockOutbound } from "../_kit/outbound";
import { call, callExit } from "../_kit/run";
import { HOUR, seedManualAccount } from "../_kit/seed";
import { freshUser, otherUser } from "../_kit/user";

describe("manual-activities/update", () => {
  // As with create, overdraw is a return value, not a failure.
  const USER = "h-mact-update";

  let T0 = 0;
  const at = (hours: number) => T0 + hours * HOUR;

  const detail = (userId: string, accountId: string) =>
    call(userId, handleGetManualAccount({ accountId }));

  const amountOf = async (userId: string, accountId: string, symbol: string) =>
    (await detail(userId, accountId)).tokens.find((t) => t.symbol === symbol)?.amount;

  /** Ledger with two entries: open 10, then reduce 2 → 8. */
  const seedLedger = async (userId: string) => {
    const acc = await seedManualAccount(userId, "手记", {
      symbol: "BTC",
      unitPrice: 100,
      amount: 10,
    });
    await call(
      userId,
      handleCreateManualActivities({
        accountId: acc.id,
        drafts: [
          {
            token: { symbol: "BTC", unitPrice: 100 },
            kind: "reduce",
            amount: 2,
            occurredAt: at(5),
          },
        ],
      }),
    );
    const acts = (await detail(userId, acc.id)).activities;
    return {
      acc,
      opening: acts.find((a) => a.amount === 10)!,
      reduce: acts.find((a) => a.amount === 2)!,
    };
  };

  beforeEach(async () => {
    blockOutbound();
    await freshUser(USER);
    await freshUser(otherUser(USER));
    T0 = Date.now() + HOUR;
  });

  describe("updateManualActivity", () => {
    it("raising the amount → holding follows", async () => {
      const { acc, opening } = await seedLedger(USER);

      const out = await call(
        USER,
        handleUpdateManualActivity({ activityId: opening.id, patch: { amount: 20 } }),
      );

      expect(out).toEqual({ ok: true });
      expect(await amountOf(USER, acc.id, "BTC")).toBe(18);
    });

    it("memo-only edit → amount and time unchanged", async () => {
      const { acc, reduce } = await seedLedger(USER);
      const before = await amountOf(USER, acc.id, "BTC");

      await call(
        USER,
        handleUpdateManualActivity({ activityId: reduce.id, patch: { memo: "手滑写错了" } }),
      );

      const after = (await detail(USER, acc.id)).activities.find((a) => a.id === reduce.id);
      expect(await amountOf(USER, acc.id, "BTC")).toBe(before);
      expect(after?.amount).toBe(2);
      expect(after?.occurredAt).toBe(reduce.occurredAt);
      expect(after?.memo).toBe("手滑写错了");
    });

    it("changing occurredAt → entry moves on the timeline", async () => {
      const { acc, reduce } = await seedLedger(USER);

      await call(
        USER,
        handleUpdateManualActivity({ activityId: reduce.id, patch: { occurredAt: at(20) } }),
      );

      const acts = (await detail(USER, acc.id)).activities;
      expect(acts.at(-1)?.id).toBe(reduce.id);
    });

    it("reduce changed to set → recomputed with set semantics", async () => {
      const { acc, reduce } = await seedLedger(USER);

      await call(
        USER,
        handleUpdateManualActivity({ activityId: reduce.id, patch: { kind: "set", amount: 3 } }),
      );

      expect(await amountOf(USER, acc.id, "BTC")).toBe(3);
    });

    it("edit that overdraws → rejected, original unchanged", async () => {
      const { acc, reduce } = await seedLedger(USER);

      const out = await call(
        USER,
        handleUpdateManualActivity({ activityId: reduce.id, patch: { amount: 999 } }),
      );

      expect(out).toEqual({ ok: false, reason: "overdraw", symbol: "BTC" });
      expect(await amountOf(USER, acc.id, "BTC")).toBe(8);
      const still = (await detail(USER, acc.id)).activities.find((a) => a.id === reduce.id);
      expect(still?.amount).toBe(2);
    });

    it("empty patch → nothing changes, fields not cleared", async () => {
      // Also pins no-throw: drizzle throws on an empty set, so the db layer short-circuits.
      const { acc, reduce } = await seedLedger(USER);

      await call(USER, handleUpdateManualActivity({ activityId: reduce.id, patch: {} }));

      const after = (await detail(USER, acc.id)).activities.find((a) => a.id === reduce.id);
      expect(after?.amount).toBe(2);
      expect(after?.kind).toBe(reduce.kind);
      expect(await amountOf(USER, acc.id, "BTC")).toBe(8);
    });

    it("editing someone else's activity → rejected, their ledger untouched", async () => {
      const theirs = await seedLedger(otherUser(USER));

      const exit = await callExit(
        USER,
        handleUpdateManualActivity({ activityId: theirs.reduce.id, patch: { amount: 1 } }),
      );

      expect(exit._tag).toBe("Failure");
      expect(await amountOf(otherUser(USER), theirs.acc.id, "BTC")).toBe(8);
    });

    it("unknown activityId → rejected", async () => {
      await seedLedger(USER);

      const exit = await callExit(
        USER,
        handleUpdateManualActivity({ activityId: "没有这个", patch: { amount: 1 } }),
      );

      expect(exit._tag).toBe("Failure");
    });

    it("negative amount / unknown kind / empty activityId → schema rejects", () => {
      expect(
        UpdateActivityInput.safeParse({ activityId: "a", patch: { amount: -1 } }).success,
      ).toBe(false);
      expect(
        UpdateActivityInput.safeParse({ activityId: "a", patch: { kind: "swap" } }).success,
      ).toBe(false);
      expect(UpdateActivityInput.safeParse({ activityId: "", patch: {} }).success).toBe(false);
    });
  });
});
