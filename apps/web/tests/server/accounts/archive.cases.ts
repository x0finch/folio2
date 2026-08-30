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
  // #527 · archiveAccount(归档 / 取消归档;归档手记账户先落一张封存快照)
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
    it("归档手记账户 → 落了一张封存快照", async () => {
      const acc = await seedManualAccount(USER, "手记", {
        symbol: "BTC",
        unitPrice: 100,
        amount: 2,
      });
      expect(await snapshotCount(acc.id)).toBe(0); // 手记平时不写快照(ADR 0018)

      await call(USER, handleArchiveAccount({ accountId: acc.id, archived: true }));

      expect(await snapshotCount(acc.id)).toBe(1);
    });

    it("取消归档 → 回到活跃,archivedAt 清空", async () => {
      const acc = await seedAccount(USER, "甲", "bitcoin");
      await call(USER, handleArchiveAccount({ accountId: acc.id, archived: true }));

      await call(USER, handleArchiveAccount({ accountId: acc.id, archived: false }));

      expect((await db(USER).accounts.getById(acc.id))?.archivedAt).toBeNull();
    });

    it("先改名再归档 → 两件事都生效", async () => {
      const acc = await seedAccount(USER, "旧名", "bitcoin");

      await call(USER, handleRenameAccount({ accountId: acc.id, label: "新名" }));
      await call(USER, handleArchiveAccount({ accountId: acc.id, archived: true }));

      expect(await labels()).toEqual(["新名"]);
      expect((await db(USER).accounts.getById(acc.id))?.archivedAt).not.toBeNull();
    });

    it("对已归档的账户再归档一次 → 不再落第二张封存快照", async () => {
      // 落两张会让曲线在归档那一刻多出一个点 —— 而它俩的值一样,读起来像同步了两次。
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

    it("归档手记账户之后 → 曲线末点停在封存那一刻,不再补实时点", async () => {
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

      // 曲线在浏览器里装(FOL-38);「不再补实时点」在原料里就看得见:`live` 是 null。
      expect(raw.live).toBeNull();
      const series = buildAccountValueHistory(raw.rows, raw.live);
      expect(series.length).toBeGreaterThan(0);
      expect(series.at(-1)?.t).toBeLessThanOrEqual(archivedAt ?? 0);
    });
  });
});
