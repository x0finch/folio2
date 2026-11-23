import { beforeEach, describe, expect, it } from "vitest";
import { handleGetManualAccount } from "@/lib/server/manual-tokens/get-account";
import { handleRemoveManualToken, RemoveManualTokenInput } from "@/lib/server/manual-tokens/remove";
import { blockOutbound } from "../_kit/outbound";
import { call, callExit, readOverview } from "../_kit/run";
import { seedManualAccount } from "../_kit/seed";
import { freshUser, otherUser } from "../_kit/user";

describe("manual-tokens/remove", () => {
  const USER = "h-mtok-remove";

  const detail = (userId: string, accountId: string) =>
    call(userId, handleGetManualAccount({ accountId }));

  beforeEach(async () => {
    blockOutbound();
    await freshUser(USER);
    await freshUser(otherUser(USER));
  });

  describe("removeManualToken", () => {
    it("removing a token → gone from detail along with its activities", async () => {
      const acc = await seedManualAccount(USER, "手记", {
        symbol: "BTC",
        unitPrice: 50_000,
        amount: 2,
      });
      const before = await detail(USER, acc.id);

      await call(
        USER,
        handleRemoveManualToken({ accountId: acc.id, tokenId: before.tokens[0].id }),
      );

      const after = await detail(USER, acc.id);
      expect(after.tokens).toEqual([]);
      expect(after.activities).toEqual([]);
    });

    it("overview right after removal → total excludes it", async () => {
      const acc = await seedManualAccount(USER, "手记", {
        symbol: "BTC",
        unitPrice: 50_000,
        amount: 2,
      });
      const before = await detail(USER, acc.id);

      await call(
        USER,
        handleRemoveManualToken({ accountId: acc.id, tokenId: before.tokens[0].id }),
      );

      const overview = await readOverview(USER, {});
      expect(overview.holdings).toEqual([]);
    });

    it("tokenId from my other account → succeeds, deletes nothing", async () => {
      // Both ownership checks pass and the delete is `WHERE accountId = ? AND tokenId = ?`, so a
      // mismatched pair deletes 0 rows: no leak, so a silent no-op is fine.
      const a = await seedManualAccount(USER, "甲", { symbol: "BTC", unitPrice: 1, amount: 1 });
      const b = await seedManualAccount(USER, "乙", { symbol: "ETH", unitPrice: 1, amount: 1 });
      const bDetail = await detail(USER, b.id);

      await call(USER, handleRemoveManualToken({ accountId: a.id, tokenId: bDetail.tokens[0].id }));

      expect((await detail(USER, b.id)).tokens).toHaveLength(1);
      expect((await detail(USER, a.id)).tokens).toHaveLength(1);
    });

    it("someone else's account → rejected, their token remains", async () => {
      const theirs = await seedManualAccount(otherUser(USER), "他们的", {
        symbol: "BTC",
        unitPrice: 1,
        amount: 1,
      });
      const theirDetail = await detail(otherUser(USER), theirs.id);

      const exit = await callExit(
        USER,
        handleRemoveManualToken({ accountId: theirs.id, tokenId: theirDetail.tokens[0].id }),
      );

      expect(exit._tag).toBe("Failure");
      expect((await detail(otherUser(USER), theirs.id)).tokens).toHaveLength(1);
    });

    it("empty accountId / tokenId → schema rejects", () => {
      expect(RemoveManualTokenInput.safeParse({ accountId: "", tokenId: "t" }).success).toBe(false);
      expect(RemoveManualTokenInput.safeParse({ accountId: "a", tokenId: "" }).success).toBe(false);
    });
  });
});
