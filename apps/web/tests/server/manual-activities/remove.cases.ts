import { beforeEach, describe, expect, it } from "vitest";
import { handleCreateManualActivities } from "@/lib/server/manual-activities/create";
import {
  handleRemoveManualActivity,
  RemoveActivityInput,
} from "@/lib/server/manual-activities/remove";
import { handleGetManualAccount } from "@/lib/server/manual-tokens/get-account";
import { blockOutbound } from "../_kit/outbound";
import { call, callExit } from "../_kit/run";
import { HOUR, seedManualAccount } from "../_kit/seed";
import { freshUser, otherUser } from "../_kit/user";

describe("manual-activities/remove", () => {
  const USER = "h-mact-remove";

  let T0 = 0;
  const at = (hours: number) => T0 + hours * HOUR;

  const detail = (userId: string, accountId: string) =>
    call(userId, handleGetManualAccount({ accountId }));

  const amountOf = async (userId: string, accountId: string, symbol: string) =>
    (await detail(userId, accountId)).tokens.find((t) => t.symbol === symbol)?.amount;

  beforeEach(async () => {
    blockOutbound();
    await freshUser(USER);
    await freshUser(otherUser(USER));
    T0 = Date.now() + HOUR;
  });

  describe("removeManualActivity", () => {
    it("removing an add → holding shrinks", async () => {
      const acc = await seedManualAccount(USER, "手记", { symbol: "BTC", unitPrice: 1, amount: 1 });
      await call(
        USER,
        handleCreateManualActivities({
          accountId: acc.id,
          drafts: [
            { token: { symbol: "BTC", unitPrice: 1 }, kind: "add", amount: 5, occurredAt: at(5) },
          ],
        }),
      );
      expect(await amountOf(USER, acc.id, "BTC")).toBe(6);
      const added = (await detail(USER, acc.id)).activities.find((a) => a.amount === 5);

      await call(USER, handleRemoveManualActivity({ accountId: acc.id, activityId: added!.id }));

      expect(await amountOf(USER, acc.id, "BTC")).toBe(1);
    });

    it("activity id from my other account → succeeds but deletes nothing there", async () => {
      const a = await seedManualAccount(USER, "甲", { symbol: "BTC", unitPrice: 1, amount: 1 });
      const b = await seedManualAccount(USER, "乙", { symbol: "ETH", unitPrice: 1, amount: 1 });
      const bAct = (await detail(USER, b.id)).activities[0];

      // The delete is `WHERE id = ? AND accountId = ?`; a mismatched pair deletes 0 rows.
      await call(USER, handleRemoveManualActivity({ accountId: a.id, activityId: bAct.id }));

      expect((await detail(USER, b.id)).activities).toHaveLength(1);
      expect((await detail(USER, a.id)).activities).toHaveLength(1);
    });

    it("someone else's activity → rejected, their ledger untouched", async () => {
      const theirs = await seedManualAccount(otherUser(USER), "他们的", {
        symbol: "BTC",
        unitPrice: 1,
        amount: 1,
      });
      const act = (await detail(otherUser(USER), theirs.id)).activities[0];

      const exit = await callExit(
        USER,
        handleRemoveManualActivity({ accountId: theirs.id, activityId: act.id }),
      );

      expect(exit._tag).toBe("Failure");
      expect((await detail(otherUser(USER), theirs.id)).activities).toHaveLength(1);
    });

    it("deleting twice → silent no-op, same as deleteTag / deleteTabPin", async () => {
      // All delete endpoints share this rule; pinned per endpoint so they don't drift apart.
      const acc = await seedManualAccount(USER, "手记", { symbol: "BTC", unitPrice: 1, amount: 1 });
      const act = (await detail(USER, acc.id)).activities[0];

      await call(USER, handleRemoveManualActivity({ accountId: acc.id, activityId: act.id }));
      await call(USER, handleRemoveManualActivity({ accountId: acc.id, activityId: act.id }));

      expect((await detail(USER, acc.id)).activities).toEqual([]);
    });

    it("empty accountId / activityId → schema rejects", () => {
      expect(RemoveActivityInput.safeParse({ accountId: "", activityId: "x" }).success).toBe(false);
      expect(RemoveActivityInput.safeParse({ accountId: "a", activityId: "" }).success).toBe(false);
    });
  });
});
