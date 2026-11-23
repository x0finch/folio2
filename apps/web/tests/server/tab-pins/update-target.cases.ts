import { InvalidInput, NotFound } from "@folio/db";
import { beforeEach, describe, expect, it } from "vitest";
import { handleUpdateTabPinTarget, UpdateTabPinInput } from "@/lib/server/tab-pins/update-target";
import { db } from "../_kit/db";
import { blockOutbound } from "../_kit/outbound";
import { call, callExit, failureOf, readTabStrip } from "../_kit/run";
import { freshUser, otherUser } from "../_kit/user";

// Runs inside tab-pins/index.test.ts: each vitest file re-evaluates the whole import graph in workerd (~9s/file), so cases are merged per directory.
describe("tab-pins/update-target", () => {
  const USER = "h-pins-update";

  const seed = async (userId: string) => {
    const pf = await db(userId).portfolios.ensureDefault();
    const account = await db(userId).accounts.create({
      connectorId: "manual",
      label: "Alpha",
      creds: null,
    });
    await db(userId).portfolios.assignAccount(account.id, pf.id);
    const tag = await db(userId).tags.create({ portfolioId: pf.id, name: "Long-term" });
    const pin = await db(userId).tabPins.create({ kind: "connector", connectorId: "manual" });
    return { pf, account, tag, pin };
  };

  beforeEach(async () => {
    blockOutbound();
    await freshUser(USER);
    await freshUser(otherUser(USER));
  });

  describe("updateTabPinTarget", () => {
    it("changing from connector to tag -> the label on the tab strip follows", async () => {
      const { pin, tag } = await seed(USER);

      await call(USER, handleUpdateTabPinTarget({ pinId: pin.id, kind: "tag", tagId: tag.id }));

      const strip = await readTabStrip(USER, {});
      expect(strip.pins[0].name).toBe("Long-term");
      expect(strip.pins[0].kind).toBe("tag");
    });

    it("after the change it's still the same pin -- id unchanged, no extra one", async () => {
      const { pin, account } = await seed(USER);

      await call(
        USER,
        handleUpdateTabPinTarget({ pinId: pin.id, kind: "account", accountId: account.id }),
      );

      const strip = await readTabStrip(USER, {});
      expect(strip.pins).toHaveLength(1);
      expect(strip.pins[0].id).toBe(pin.id);
    });

    it("changing the middle one of three pins -> the other two keep their order", async () => {
      const { tag } = await seed(USER);
      // Each pinned connector needs an account in this portfolio, or the pin doesn't show at all.
      for (const c of ["bitcoin", "binance"] as const) {
        await db(USER).accounts.create({ connectorId: c, label: c, creds: null });
      }
      const second = await db(USER).tabPins.create({ kind: "connector", connectorId: "bitcoin" });
      await db(USER).tabPins.create({ kind: "connector", connectorId: "binance" });
      const before = (await readTabStrip(USER, {})).pins.map((p) => p.id);

      await call(USER, handleUpdateTabPinTarget({ pinId: second.id, kind: "tag", tagId: tag.id }));

      expect((await readTabStrip(USER, {})).pins.map((p) => p.id)).toEqual(before);
    });

    // Changing the target used to have no validation at all: pointing a pin at a connector made it appear in another portfolio,
    // pushing that one to 4 while its + button was hidden by >=3, leaving the UI self-contradictory.
    it("retargeting also respects the cap: a new target that pushes a portfolio to 4 -> rejected, original target kept", async () => {
      const { pf } = await seed(USER); // seed already has 1 manual pin
      for (const c of ["binance", "okx"] as const) {
        const acc = await db(USER).accounts.create({ connectorId: c, label: c, creds: null });
        await db(USER).portfolios.assignAccount(acc.id, pf.id);
        await db(USER).tabPins.create({ kind: "connector", connectorId: c });
      }
      // The default portfolio now has 3. Another portfolio has a pin; retargeting it at a connector in the default one -> rejected.
      const watch = await db(USER).portfolios.create({ name: "Watch" });
      const there = await db(USER).accounts.create({
        connectorId: "bitcoin",
        label: "Over there",
        creds: null,
      });
      await db(USER).portfolios.assignAccount(there.id, watch.id);
      const watchPin = await db(USER).tabPins.create({ kind: "connector", connectorId: "bitcoin" });

      const exit = await callExit(
        USER,
        handleUpdateTabPinTarget({ pinId: watchPin.id, kind: "connector", connectorId: "okx" }),
      );

      expect(failureOf(exit)).toBeInstanceOf(InvalidInput);
      // Original target kept: the one in Watch is still bitcoin.
      const strip = await readTabStrip(USER, { portfolioId: watch.id });
      expect(strip.pins.map((p) => p.connectorId)).toEqual(["bitcoin"]);
    });

    it("retargeting doesn't compete with itself for quota: in a full portfolio, changing one of its pins still works", async () => {
      const { pf, tag } = await seed(USER);
      for (const c of ["binance", "okx"] as const) {
        const acc = await db(USER).accounts.create({ connectorId: c, label: c, creds: null });
        await db(USER).portfolios.assignAccount(acc.id, pf.id);
        await db(USER).tabPins.create({ kind: "connector", connectorId: c });
      }
      const pins = await db(USER).tabPins.list();
      // 3 full; retarget one at a tag in the same portfolio -- its old appearance doesn't hold quota, so this must pass.
      await call(USER, handleUpdateTabPinTarget({ pinId: pins[0].id, kind: "tag", tagId: tag.id }));

      expect((await readTabStrip(USER, {})).pins).toHaveLength(3);
    });

    it("retargeting at someone else's tag -> rejected, original target kept", async () => {
      const { pin } = await seed(USER);
      const theirs = await seed(otherUser(USER));

      const exit = await callExit(
        USER,
        handleUpdateTabPinTarget({ pinId: pin.id, kind: "tag", tagId: theirs.tag.id }),
      );

      expect(failureOf(exit)).toBeInstanceOf(NotFound);
      expect((await readTabStrip(USER, {})).pins[0].kind).toBe("connector");
    });

    it("empty pinId -> rejected by schema", () => {
      expect(UpdateTabPinInput.safeParse({ pinId: "", kind: "connector" }).success).toBe(false);
    });
  });
});
