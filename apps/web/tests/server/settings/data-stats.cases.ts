import { beforeEach, describe, expect, it } from "vitest";
import { handleGetDataStats } from "@/lib/server/settings/data-stats";
import { db } from "../_kit/db";
import { blockOutbound } from "../_kit/outbound";
import { call } from "../_kit/run";
import { seedAccount } from "../_kit/seed";
import { freshUser, otherUser } from "../_kit/user";

describe("settings/data-stats", () => {
  const USER = "h-set-stats";

  beforeEach(async () => {
    blockOutbound();
    await freshUser(USER);
    await freshUser(otherUser(USER));
  });

  describe("getDataStats", () => {
    it("with an account → hasData true", async () => {
      await seedAccount(USER, "甲");

      expect(await call(USER, handleGetDataStats())).toEqual({ hasData: true });
    });

    it("new user → hasData false", async () => {
      expect(await call(USER, handleGetDataStats())).toEqual({ hasData: false });
    });

    it("only archived accounts → still hasData: it answers 'would an import collide', not 'is this a new user'", async () => {
      // Archived data still exists and a merge import still collides with it. For "is this a new
      // user", add a separate op rather than changing this one.
      const acc = await seedAccount(USER, "甲");
      await db(USER).accounts.setArchived(acc.id, true);

      expect(await call(USER, handleGetDataStats())).toEqual({ hasData: true });
    });

    it("another user has data, I don't → false for me", async () => {
      await seedAccount(otherUser(USER), "他们的");

      expect(await call(USER, handleGetDataStats())).toEqual({ hasData: false });
    });

    it("after deleting all accounts → false again", async () => {
      const acc = await seedAccount(USER, "甲");
      await db(USER).accounts.remove(acc.id);

      expect(await call(USER, handleGetDataStats())).toEqual({ hasData: false });
    });
  });
});
