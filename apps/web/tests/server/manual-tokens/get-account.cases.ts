import { beforeEach, describe, expect, it } from "vitest";
import {
  GetManualAccountInput,
  handleGetManualAccount,
} from "@/lib/server/manual-tokens/get-account";
import { blockOutbound } from "../_kit/outbound";
import { call, callExit } from "../_kit/run";
import { seedAccount, seedManualAccount } from "../_kit/seed";
import { freshUser, otherUser } from "../_kit/user";

describe("manual-tokens/get-account", () => {
  const USER = "h-mtok-detail";

  beforeEach(async () => {
    blockOutbound();
    await freshUser(USER);
    await freshUser(otherUser(USER));
  });

  describe("getManualAccount", () => {
    it("one token → in the detail, holding from the opening entry", async () => {
      const acc = await seedManualAccount(USER, "手记", {
        symbol: "BTC",
        unitPrice: 50_000,
        amount: 2,
      });

      const detail = await call(USER, handleGetManualAccount({ accountId: acc.id }));

      expect(detail.tokens).toHaveLength(1);
      expect(detail.tokens[0].symbol).toBe("BTC");
      expect(detail.tokens[0].amount).toBe(2);
    });

    it("non-manual account id → empty detail", async () => {
      const acc = await seedAccount(USER, "链上", "bitcoin");

      const detail = await call(USER, handleGetManualAccount({ accountId: acc.id }));

      expect(detail.tokens).toEqual([]);
      expect(detail.activities).toEqual([]);
    });

    it("someone else's accountId → rejected", async () => {
      const theirs = await seedManualAccount(otherUser(USER), "他们的", {
        symbol: "BTC",
        unitPrice: 1,
        amount: 1,
      });

      const exit = await callExit(USER, handleGetManualAccount({ accountId: theirs.id }));

      expect(exit._tag).toBe("Failure");
    });

    it("empty accountId → schema rejects", () => {
      expect(GetManualAccountInput.safeParse({ accountId: "" }).success).toBe(false);
    });
  });
});
