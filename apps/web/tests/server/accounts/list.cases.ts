import { beforeEach, describe, expect, it } from "vitest";
import { handleListAccounts } from "@/lib/server/accounts/list";
import { db } from "../_kit/db";
import { fakeRegistry } from "../_kit/fakes";
import { blockOutbound } from "../_kit/outbound";
import { callWithRegistry } from "../_kit/run";
import { freshUser, otherUser } from "../_kit/user";

describe("accounts/list", () => {
  const USER = "h-acc-list";

  const listed = async () => {
    const { registry } = await fakeRegistry();
    return callWithRegistry(USER, registry, handleListAccounts());
  };

  beforeEach(async () => {
    blockOutbound();
    await freshUser(USER);
    await freshUser(otherUser(USER));
  });

  describe("listAccounts", () => {
    it("on-chain, CEX and manual all listed with matching connectorId", async () => {
      await db(USER).accounts.create({
        connectorId: "bitcoin",
        label: "冷钱包",
        creds: JSON.stringify({ addressOrXpub: "bc1-x" }),
      });
      await db(USER).accounts.create({
        connectorId: "binance",
        label: "币安",
        creds: JSON.stringify({ apiKey: "k", secret: "已加密的东西" }),
      });
      await db(USER).accounts.create({
        connectorId: "manual",
        label: "手记",
        creds: JSON.stringify({ tokens: "[]" }),
      });

      const rows = await listed();

      expect(rows.map((r) => r.connectorId).sort()).toEqual(["binance", "bitcoin", "manual"]);
    });

    it("CEX account with apiKey but no secret → needsCredentials", async () => {
      await db(USER).accounts.create({
        connectorId: "binance",
        label: "币安",
        creds: JSON.stringify({ apiKey: "k" }),
      });

      const rows = await listed();

      expect(rows[0].needsCredentials).toBe(true);
    });

    it("secret fields never returned, semi fields masked", async () => {
      await db(USER).accounts.create({
        connectorId: "binance",
        label: "币安",
        creds: JSON.stringify({ apiKey: "0123456789abcdef", secret: "密文占位" }),
      });

      const rows = await listed();
      const safe = JSON.stringify(rows[0].credsSafe);

      expect(safe).not.toContain("密文占位");
      expect(rows[0].credsSafe).not.toHaveProperty("secret");
      expect(safe).not.toContain("0123456789abcdef"); // semi is never returned whole
    });

    it("malformed creds JSON → row treated as incomplete, list still loads", async () => {
      await db(USER).accounts.create({
        connectorId: "binance",
        label: "坏的",
        creds: "{这不是 JSON",
      });
      await db(USER).accounts.create({
        connectorId: "bitcoin",
        label: "好的",
        creds: JSON.stringify({ addressOrXpub: "bc1-x" }),
      });

      // A bad row degrades to "no creds" so the accounts page, where creds get fixed, still loads.
      const rows = await listed();

      expect(rows.map((r) => r.label).sort()).toEqual(["坏的", "好的"]); // sorted by code point
      const bad = rows.find((r) => r.label === "坏的");
      expect(bad?.needsCredentials).toBe(true);
      expect(bad?.credsSafe).toEqual({});
    });

    it("null creds → incomplete, no throw", async () => {
      await db(USER).accounts.create({ connectorId: "binance", label: "空的", creds: null });

      const rows = await listed();

      expect(rows[0].needsCredentials).toBe(true);
    });

    it("no accounts → empty array, not null", async () => {
      expect(await listed()).toEqual([]);
    });

    it("archived accounts are listed (with archivedAt)", async () => {
      const acc = await db(USER).accounts.create({
        connectorId: "bitcoin",
        label: "归档",
        creds: JSON.stringify({ addressOrXpub: "bc1-x" }),
      });
      await db(USER).accounts.setArchived(acc.id, true);

      const rows = await listed();

      expect(rows).toHaveLength(1);
      expect(rows[0].archivedAt).not.toBeNull();
    });

    it("other users' accounts aren't listed", async () => {
      await db(otherUser(USER)).accounts.create({
        connectorId: "bitcoin",
        label: "他们的",
        creds: null,
      });

      expect(await listed()).toEqual([]);
    });
  });
});
