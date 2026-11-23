import { beforeEach, describe, expect, it } from "vitest";
import { handleCreateTabPin } from "@/lib/server/tab-pins/create";
import { DeleteTabPinInput, handleDeleteTabPin } from "@/lib/server/tab-pins/delete";
import { db } from "../_kit/db";
import { blockOutbound } from "../_kit/outbound";
import { call, readTabStrip } from "../_kit/run";
import { freshUser, otherUser } from "../_kit/user";

// Runs inside tab-pins/index.test.ts: each vitest file re-evaluates the whole import graph in workerd (~9s/file), so cases are merged per directory.
describe("tab-pins/delete", () => {
  const USER = "h-pins-delete";

  const pins = (userId: string) => readTabStrip(userId, {});

  // Creates an account for this connector, or the pin wouldn't show: a pin only appears if the view has an account for its connector.
  // `accounts.create` puts it in the default portfolio itself.
  const withAccount = (userId: string, connectorId: "manual" | "bitcoin" | "binance" | "okx") =>
    db(userId).accounts.create({ connectorId, label: connectorId, creds: null });

  beforeEach(async () => {
    blockOutbound();
    await freshUser(USER);
    await freshUser(otherUser(USER));
  });

  describe("deleteTabPin", () => {
    it("deleting one -> one fewer, the other two remain", async () => {
      for (const c of ["manual", "bitcoin", "binance"] as const) await withAccount(USER, c);
      const a = await db(USER).tabPins.create({ kind: "connector", connectorId: "manual" });
      await db(USER).tabPins.create({ kind: "connector", connectorId: "bitcoin" });
      await db(USER).tabPins.create({ kind: "connector", connectorId: "binance" });

      await call(USER, handleDeleteTabPin({ pinId: a.id }));

      const strip = await pins(USER);
      expect(strip.pins).toHaveLength(2);
      expect(strip.pins.map((p) => p.connectorId).sort()).toEqual(["binance", "bitcoin"]);
    });

    it("deleting an already-deleted pin -> silently idempotent (same rule as deleteTag), not NotFound", async () => {
      // Both db removes are a bare DELETE; one shape shouldn't have two behaviors, so pin the status quo: silent.
      await withAccount(USER, "manual");
      const a = await db(USER).tabPins.create({ kind: "connector", connectorId: "manual" });

      await call(USER, handleDeleteTabPin({ pinId: a.id }));
      await call(USER, handleDeleteTabPin({ pinId: a.id }));

      expect((await pins(USER)).pins).toEqual([]);
    });

    it("delete then immediately recreate -> allowed, the cap count dropped too", async () => {
      for (const c of ["manual", "bitcoin", "binance", "okx"] as const) await withAccount(USER, c);
      const made = [];
      for (const c of ["manual", "bitcoin", "binance"]) {
        made.push(await call(USER, handleCreateTabPin({ kind: "connector", connectorId: c })));
      }

      await call(USER, handleDeleteTabPin({ pinId: made[0].id }));
      await call(USER, handleCreateTabPin({ kind: "connector", connectorId: "okx" }));

      expect((await pins(USER)).pins.map((p) => p.connectorId).sort()).toEqual([
        "binance",
        "bitcoin",
        "okx",
      ]);
    });

    it("deleting someone else's pinId -> their pin is untouched", async () => {
      await withAccount(otherUser(USER), "manual");
      const theirs = await db(otherUser(USER)).tabPins.create({
        kind: "connector",
        connectorId: "manual",
      });

      await call(USER, handleDeleteTabPin({ pinId: theirs.id }));

      expect((await pins(otherUser(USER))).pins).toHaveLength(1);
    });

    it("empty pinId -> rejected by schema", () => {
      expect(DeleteTabPinInput.safeParse({ pinId: "" }).success).toBe(false);
    });
  });
});
