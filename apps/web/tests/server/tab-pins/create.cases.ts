import { InvalidInput, NotFound } from "@folio/db";
import { beforeEach, describe, expect, it } from "vitest";
import { handleArchiveAccount } from "@/lib/server/accounts/archive";
import { handleCreateTabPin, PinTargetInput } from "@/lib/server/tab-pins/create";
import { db } from "../_kit/db";
import { blockOutbound } from "../_kit/outbound";
import { call, callExit, failureOf, readTabStrip } from "../_kit/run";
import { freshUser, otherUser } from "../_kit/user";

// Runs inside tab-pins/index.test.ts: each vitest file re-evaluates the whole import graph in workerd (~9s/file), so cases are merged per directory.
describe("tab-pins/create", () => {
  const USER = "h-pins-create";

  const seed = async (userId: string) => {
    const pf = await db(userId).portfolios.ensureDefault();
    const account = await db(userId).accounts.create({
      connectorId: "manual",
      label: "Alpha",
      creds: null,
    });
    await db(userId).portfolios.assignAccount(account.id, pf.id);
    const tag = await db(userId).tags.create({ portfolioId: pf.id, name: "Long-term" });
    return { pf, account, tag };
  };

  beforeEach(async () => {
    blockOutbound();
    await freshUser(USER);
    await freshUser(otherUser(USER));
  });

  describe("createTabPin", () => {
    it("pin targeting a tag -> label is the tag name, not the tagId", async () => {
      const { tag } = await seed(USER);

      await call(USER, handleCreateTabPin({ kind: "tag", tagId: tag.id }));

      const strip = await readTabStrip(USER, {});
      expect(strip.pins[0].name).toBe("Long-term");
      expect(strip.pins[0].name).not.toBe(tag.id);
    });

    it("pin targeting someone else's tag -> rejected, no cross-user pin can be created", async () => {
      await seed(USER);
      const theirs = await seed(otherUser(USER));

      const exit = await callExit(USER, handleCreateTabPin({ kind: "tag", tagId: theirs.tag.id }));

      expect(failureOf(exit)).toBeInstanceOf(NotFound);
      expect((await readTabStrip(USER, {})).pins).toEqual([]);
    });

    it("kind=tag without a tagId -> InvalidInput, not a defect", async () => {
      // The input schema makes all three target fields optional (one schema for three kinds), so this combination gets in;
      // it's a caller typo and should get a plain message.
      await seed(USER);

      const exit = await callExit(USER, handleCreateTabPin({ kind: "tag" }));

      expect(failureOf(exit)).toBeInstanceOf(InvalidInput);
    });

    // The cap is 3 per portfolio, counting what is visible (same pure function as whether the tab strip shows them).
    // Which portfolios a pin appears in is decided by what it points at, not by what the caller claims (a caller passing an empty
    // portfolio's id would otherwise always be let through).
    it("a portfolio with 3 pins -> the 4th is rejected (typed failure, not a 500)", async () => {
      const { pf } = await seed(USER);
      for (const c of ["binance", "okx", "hyperliquid"] as const) {
        const acc = await db(USER).accounts.create({ connectorId: c, label: c, creds: null });
        await db(USER).portfolios.assignAccount(acc.id, pf.id);
        await call(USER, handleCreateTabPin({ kind: "connector", connectorId: c }));
      }

      const exit = await callExit(
        USER,
        handleCreateTabPin({ kind: "connector", connectorId: "manual" }),
      );

      expect(failureOf(exit)).toBeInstanceOf(InvalidInput);
      expect((await readTabStrip(USER, {})).pins).toHaveLength(3);
    });

    it("portfolio A is full, B can still create (quota is per portfolio)", async () => {
      const { pf } = await seed(USER);
      for (const c of ["binance", "okx", "hyperliquid"] as const) {
        const acc = await db(USER).accounts.create({ connectorId: c, label: c, creds: null });
        await db(USER).portfolios.assignAccount(acc.id, pf.id);
        await call(USER, handleCreateTabPin({ kind: "connector", connectorId: c }));
      }
      const watch = await db(USER).portfolios.create({ name: "Watch" });
      const there = await db(USER).accounts.create({
        connectorId: "bitcoin",
        label: "Over there",
        creds: null,
      });
      await db(USER).portfolios.assignAccount(there.id, watch.id);

      // No need to tell the server "I'm in Watch": bitcoin has accounts only in Watch, so this pin appears only there
      // and counts only there.
      await call(USER, handleCreateTabPin({ kind: "connector", connectorId: "bitcoin" }));

      // Watch sees only the one just created; the default portfolio still has its three.
      expect((await readTabStrip(USER, { portfolioId: watch.id })).pins).toHaveLength(1);
      expect((await readTabStrip(USER, {})).pins).toHaveLength(3);
    });

    it("a target in another portfolio can't bypass the cap either (quota follows the portfolio the pin actually appears in)", async () => {
      // Default portfolio is full with 3; creating a pin pointing at an account in it is rejected whatever the caller claims,
      // since it will appear there. An earlier version taking portfolioId could be bypassed.
      const { pf, account } = await seed(USER);
      for (const c of ["binance", "okx", "hyperliquid"] as const) {
        const acc = await db(USER).accounts.create({ connectorId: c, label: c, creds: null });
        await db(USER).portfolios.assignAccount(acc.id, pf.id);
        await call(USER, handleCreateTabPin({ kind: "connector", connectorId: c }));
      }
      // Create an empty portfolio: with it present, the wrong path of counting quota in an empty portfolio really exists.
      await db(USER).portfolios.create({ name: "Empty" });

      const exit = await callExit(
        USER,
        handleCreateTabPin({ kind: "account", accountId: account.id }),
      );

      expect(failureOf(exit)).toBeInstanceOf(InvalidInput);
      expect((await readTabStrip(USER, {})).pins).toHaveLength(3);
    });

    it("tag pins and connector pins share one quota (after 3, a tag pin is rejected too)", async () => {
      const { pf, tag } = await seed(USER);
      for (const c of ["binance", "okx", "hyperliquid"] as const) {
        const acc = await db(USER).accounts.create({ connectorId: c, label: c, creds: null });
        await db(USER).portfolios.assignAccount(acc.id, pf.id);
        await call(USER, handleCreateTabPin({ kind: "connector", connectorId: c }));
      }

      const exit = await callExit(USER, handleCreateTabPin({ kind: "tag", tagId: tag.id }));

      expect(failureOf(exit)).toBeInstanceOf(InvalidInput);
    });

    // Archiving auto-unpins: a pin is a frequently-viewed lens and a sealed account's shortcut is meaningless. Otherwise it only
    // disappears from the tab strip (pinsInView filters active accounts) while still holding quota, then reappears on unarchive
    // and may push the portfolio to 4. Unarchiving does not restore the pin (the row is gone; pin again to view).
    it("archiving a pinned account -> the pin is deleted too; unarchiving doesn't restore it", async () => {
      const { pf, account } = await seed(USER);
      for (const c of ["binance", "okx"] as const) {
        const acc = await db(USER).accounts.create({ connectorId: c, label: c, creds: null });
        await db(USER).portfolios.assignAccount(acc.id, pf.id);
        await call(USER, handleCreateTabPin({ kind: "connector", connectorId: c }));
      }
      await call(USER, handleCreateTabPin({ kind: "account", accountId: account.id }));
      // 3 full. Archive a pinned account -> its pin is deleted, quota really frees up -> a 4th can be created.
      await call(USER, handleArchiveAccount({ accountId: account.id, archived: true }));
      expect(await db(USER).tabPins.list()).toHaveLength(2);
      await call(USER, handleCreateTabPin({ kind: "connector", connectorId: "manual" }));
      // Unarchive: the account returns, the pin doesn't -- the tab strip stays at 3, never reaching 4.
      await call(USER, handleArchiveAccount({ accountId: account.id, archived: false }));

      expect((await readTabStrip(USER, {})).pins).toHaveLength(3);
    });

    it("kind not in the enum -> rejected by schema", () => {
      expect(PinTargetInput.safeParse({ kind: "portfolio" }).success).toBe(false);
    });
  });
});
