import { beforeEach, describe, expect, it } from "vitest";
import {
  handleGetValuationSettings,
  handleUpdateValuationSettings,
  ValuationInput,
} from "@/lib/server/settings/valuation";
import { blockOutbound } from "../_kit/outbound";
import { call } from "../_kit/run";
import { freshUser, otherUser } from "../_kit/user";

describe("settings/valuation", () => {
  const USER = "h-set-valuation";

  beforeEach(async () => {
    blockOutbound();
    await freshUser(USER);
    await freshUser(otherUser(USER));
  });

  describe("getValuationSettings", () => {
    it("never set → default setting", async () => {
      const settings = await call(USER, handleGetValuationSettings());

      expect(settings.valuationMode).toBeDefined();
      expect(["self-first", "source-first"]).toContain(settings.valuationMode);
    });

    it("reading twice gives the same result (no side effects)", async () => {
      const first = await call(USER, handleGetValuationSettings());
      const second = await call(USER, handleGetValuationSettings());

      expect(second).toEqual(first);
    });
  });

  describe("updateValuationSettings", () => {
    it("set to source-first → reads back source-first", async () => {
      await call(USER, handleUpdateValuationSettings({ mode: "source-first" }));

      expect((await call(USER, handleGetValuationSettings())).valuationMode).toBe("source-first");
    });

    it("setting the same value again → idempotent", async () => {
      await call(USER, handleUpdateValuationSettings({ mode: "self-first" }));
      await call(USER, handleUpdateValuationSettings({ mode: "self-first" }));

      expect((await call(USER, handleGetValuationSettings())).valuationMode).toBe("self-first");
    });

    it("toggling twice → last write wins", async () => {
      await call(USER, handleUpdateValuationSettings({ mode: "source-first" }));
      await call(USER, handleUpdateValuationSettings({ mode: "self-first" }));

      expect((await call(USER, handleGetValuationSettings())).valuationMode).toBe("self-first");
    });

    it("value outside the enum → schema rejects", () => {
      expect(ValuationInput.safeParse({ mode: "whatever" }).success).toBe(false);
      expect(ValuationInput.safeParse({}).success).toBe(false);
    });

    it("changing mine doesn't affect others", async () => {
      await call(otherUser(USER), handleUpdateValuationSettings({ mode: "source-first" }));

      await call(USER, handleUpdateValuationSettings({ mode: "self-first" }));

      expect((await call(otherUser(USER), handleGetValuationSettings())).valuationMode).toBe(
        "source-first",
      );
    });
  });
});
