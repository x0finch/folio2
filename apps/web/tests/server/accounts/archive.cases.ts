import { beforeEach, describe, expect, it } from "vitest";
import { buildAccountValueHistory } from "@/lib/core/history";
import { handleArchiveAccount } from "@/lib/server/accounts/archive";
import { handleGetAccountHistory } from "@/lib/server/accounts/history";
import { handleListAccounts } from "@/lib/server/accounts/list";
import { handleRenameAccount } from "@/lib/server/accounts/rename";
import { db } from "../_kit/db";
import { fakeRegistry } from "../_kit/fakes";
import { blockOutbound } from "../_kit/outbound";
import { call, callWithRegistry } from "../_kit/run";
import { seedAccount, seedManualAccount } from "../_kit/seed";
import { freshUser } from "../_kit/user";

describe("accounts/archive", () => {
  const USER = "h-acc-archive";

  const labels = async () => {
    const { registry } = await fakeRegistry();
    const rows = await callWithRegistry(USER, registry, handleListAccounts());
    return rows.map((r) => r.label);
  };

  const snapshotCount = async (accountId: string) =>
    (await db(USER).snapshots.listByAccount(accountId)).length;

  beforeEach(async () => {
    blockOutbound();
    await freshUser(USER);
  });

  describe("archiveAccount", () => {
    it("archiving a manual account writes a sealing snapshot", async () => {
      const acc = await seedManualAccount(USER, "手记", {
        symbol: "BTC",
        unitPrice: 100,
        amount: 2,
      });
      expect(await snapshotCount(acc.id)).toBe(0); // manual accounts don't snapshot otherwise

      await call(USER, handleArchiveAccount({ accountId: acc.id, archived: true }));

      expect(await snapshotCount(acc.id)).toBe(1);
    });

    it("unarchive → active again, archivedAt cleared", async () => {
      const acc = await seedAccount(USER, "甲", "bitcoin");
      await call(USER, handleArchiveAccount({ accountId: acc.id, archived: true }));

      await call(USER, handleArchiveAccount({ accountId: acc.id, archived: false }));

      expect((await db(USER).accounts.getById(acc.id))?.archivedAt).toBeNull();
    });

    it("rename then archive → both take effect", async () => {
      const acc = await seedAccount(USER, "旧名", "bitcoin");

      await call(USER, handleRenameAccount({ accountId: acc.id, label: "新名" }));
      await call(USER, handleArchiveAccount({ accountId: acc.id, archived: true }));

      expect(await labels()).toEqual(["新名"]);
      expect((await db(USER).accounts.getById(acc.id))?.archivedAt).not.toBeNull();
    });

    it("archiving an already-archived account → no second sealing snapshot", async () => {
      // Two would add a duplicate point to the curve at the archive moment.
      const acc = await seedManualAccount(USER, "手记", {
        symbol: "BTC",
        unitPrice: 100,
        amount: 2,
      });
      await call(USER, handleArchiveAccount({ accountId: acc.id, archived: true }));
      expect(await snapshotCount(acc.id)).toBe(1);

      await call(USER, handleArchiveAccount({ accountId: acc.id, archived: true }));

      expect(await snapshotCount(acc.id)).toBe(1);
    });

    it("archived manual account → curve ends at the seal, no live point appended", async () => {
      const acc = await seedManualAccount(USER, "手记", {
        symbol: "BTC",
        unitPrice: 100,
        amount: 2,
      });
      await call(USER, handleArchiveAccount({ accountId: acc.id, archived: true }));
      const archivedAt = (await db(USER).accounts.getById(acc.id))?.archivedAt;

      const raw = await call(
        USER,
        handleGetAccountHistory({ accountId: acc.id, connectorId: "manual" }),
      );

      // Curves are built client-side; "no live point" shows in the raw data as `live: null`.
      expect(raw.live).toBeNull();
      const series = buildAccountValueHistory(raw.rows, raw.live);
      expect(series.length).toBeGreaterThan(0);
      expect(series.at(-1)?.t).toBeLessThanOrEqual(archivedAt ?? 0);
    });
  });
});
