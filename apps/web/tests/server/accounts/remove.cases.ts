import { beforeEach, describe, expect, it } from "vitest";
import { handleRemoveAccount, RemoveAccountInput } from "@/lib/server/accounts/remove";
import { handleListAccountTags } from "@/lib/server/tags/account-tags";
import { handleListTags } from "@/lib/server/tags/list";
import { countRows, db } from "../_kit/db";
import { blockOutbound } from "../_kit/outbound";
import { call, readOverview, readTabStrip } from "../_kit/run";
import { seedAccount, seedSnapshot } from "../_kit/seed";
import { freshUser, otherUser } from "../_kit/user";

describe("accounts/remove", () => {
  const USER = "h-acc-remove";
  const BTC = "token-btc";

  beforeEach(async () => {
    blockOutbound();
    await freshUser(USER);
    await freshUser(otherUser(USER));
  });

  describe("removeAccount", () => {
    it("removing a tagged account → tag remains, just unlinked", async () => {
      const pf = await db(USER).portfolios.ensureDefault();
      const acc = await seedAccount(USER, "甲", "bitcoin");
      await db(USER).portfolios.assignAccount(acc.id, pf.id);
      const tag = await db(USER).tags.create({ portfolioId: pf.id, name: "长期" });
      await db(USER).tags.attach(acc.id, tag.id);

      await call(USER, handleRemoveAccount({ accountId: acc.id }));

      expect(await call(USER, handleListTags())).toHaveLength(1);
      expect(await call(USER, handleListAccountTags())).toEqual([]);
    });

    it("removing a pinned account → no dangling tab", async () => {
      const acc = await seedAccount(USER, "甲", "bitcoin");
      await db(USER).tabPins.create({ kind: "account", accountId: acc.id });

      await call(USER, handleRemoveAccount({ accountId: acc.id }));

      expect((await readTabStrip(USER, {})).pins).toEqual([]);
    });

    it("removing a portfolio's only member → portfolio remains, empty", async () => {
      const pf = await db(USER).portfolios.create({ name: "只有一个成员" });
      const acc = await seedAccount(USER, "甲", "bitcoin");
      await db(USER).portfolios.assignAccount(acc.id, pf.id);

      await call(USER, handleRemoveAccount({ accountId: acc.id }));

      expect((await db(USER).portfolios.list()).map((p) => p.id)).toContain(pf.id);
    });

    it("overview right after removal → total excludes it", async () => {
      const keep = await seedAccount(USER, "留着", "bitcoin");
      await seedSnapshot(USER, keep.id, Date.now(), [{ tokenId: BTC, amount: 1, usdValue: 100 }]);
      const gone = await seedAccount(USER, "删掉", "bitcoin");
      await seedSnapshot(USER, gone.id, Date.now(), [{ tokenId: BTC, amount: 1, usdValue: 900 }]);

      await call(USER, handleRemoveAccount({ accountId: gone.id }));

      expect((await readOverview(USER, {})).totalUsd).toBe(100);
    });

    it("unknown id → silent no-op, like other deletes", async () => {
      await call(USER, handleRemoveAccount({ accountId: "没有这个" }));

      expect(await countRows("accounts", USER)).toBe(0);
    });

    it("removing someone else's account → theirs remains", async () => {
      const theirs = await seedAccount(otherUser(USER), "他们的", "bitcoin");

      await call(USER, handleRemoveAccount({ accountId: theirs.id }));

      expect(await countRows("accounts", otherUser(USER))).toBe(1);
    });

    it("empty accountId → schema rejects", () => {
      expect(RemoveAccountInput.safeParse({ accountId: "" }).success).toBe(false);
    });
  });
});
