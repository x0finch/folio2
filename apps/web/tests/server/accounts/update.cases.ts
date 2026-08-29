import { beforeEach, describe, expect, it } from "vitest";
import { buildAccountValueHistory } from "@/lib/core/history";
import { handleGetAccountHistory } from "@/lib/server/accounts/history";
import { handleListAccounts } from "@/lib/server/accounts/list";
import { handleUpdateAccount, UpdateAccountInput } from "@/lib/server/accounts/update";
import { db } from "../_kit/db";
import { fakeRegistry } from "../_kit/fakes";
import { blockOutbound } from "../_kit/outbound";
import { call, callExit, callWithRegistry } from "../_kit/run";
import { seedAccount, seedManualAccount } from "../_kit/seed";
import { freshUser, otherUser } from "../_kit/user";

// 合并进 accounts/index.test.ts 跑(#527 后续件 2):每个 vitest 文件要在 workerd 里
// 重新评估整张 import 图(实测 ~9s/文件),按目录合并把这笔钱只付一次。
describe("accounts/update", () => {
  // #527 · updateAccount(改名 / 归档 / 取消归档;归档手记账户先落一张封存快照)
  const USER = "h-acc-update";

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
    await freshUser(otherUser(USER));
  });

  describe("updateAccount", () => {
    it("改名 → 列表里是新名字", async () => {
      const acc = await seedAccount(USER, "旧名", "bitcoin");

      await call(USER, handleUpdateAccount({ accountId: acc.id, label: "新名" }));

      expect(await labels()).toEqual(["新名"]);
    });

    it("归档手记账户 → 落了一张封存快照", async () => {
      const acc = await seedManualAccount(USER, "手记", {
        symbol: "BTC",
        unitPrice: 100,
        amount: 2,
      });
      expect(await snapshotCount(acc.id)).toBe(0); // 手记平时不写快照(ADR 0018)

      await call(USER, handleUpdateAccount({ accountId: acc.id, archived: true }));

      expect(await snapshotCount(acc.id)).toBe(1);
    });

    it("取消归档 → 回到活跃,archivedAt 清空", async () => {
      const acc = await seedAccount(USER, "甲", "bitcoin");
      await call(USER, handleUpdateAccount({ accountId: acc.id, archived: true }));

      await call(USER, handleUpdateAccount({ accountId: acc.id, archived: false }));

      expect((await db(USER).accounts.getById(acc.id))?.archivedAt).toBeNull();
    });

    it("同时传新名字和归档 → 两件事都生效", async () => {
      const acc = await seedAccount(USER, "旧名", "bitcoin");

      await call(USER, handleUpdateAccount({ accountId: acc.id, label: "新名", archived: true }));

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
      await call(USER, handleUpdateAccount({ accountId: acc.id, archived: true }));
      expect(await snapshotCount(acc.id)).toBe(1);

      await call(USER, handleUpdateAccount({ accountId: acc.id, archived: true }));

      expect(await snapshotCount(acc.id)).toBe(1);
    });

    it("归档手记账户之后 → 曲线末点停在封存那一刻,不再补实时点", async () => {
      const acc = await seedManualAccount(USER, "手记", {
        symbol: "BTC",
        unitPrice: 100,
        amount: 2,
      });
      await call(USER, handleUpdateAccount({ accountId: acc.id, archived: true }));
      const archivedAt = (await db(USER).accounts.getById(acc.id))?.archivedAt;

      const raw = await call(
        USER,
        handleGetAccountHistory({ accountId: acc.id, connectorId: "manual" }),
      );

      // 曲线在浏览器里装(FOL-38);「不再补实时点」在原料里就看得见:`live` 是 null。
      expect(raw.live).toBeNull();
      const series = buildAccountValueHistory(raw.rows, undefined, raw.live);
      expect(series.length).toBeGreaterThan(0);
      expect(series.at(-1)?.t).toBeLessThanOrEqual(archivedAt ?? 0);
    });

    it("改别人的账户 → 对方那个名字没变", async () => {
      const theirs = await seedAccount(otherUser(USER), "他们的", "bitcoin");

      await callExit(USER, handleUpdateAccount({ accountId: theirs.id, label: "被我改了" }));

      expect((await db(otherUser(USER)).accounts.getById(theirs.id))?.label).toBe("他们的");
    });

    it("名字改成空串 / 纯空格 → schema 拒", () => {
      expect(UpdateAccountInput.safeParse({ accountId: "a", label: "" }).success).toBe(false);
      expect(UpdateAccountInput.safeParse({ accountId: "a", label: "  " }).success).toBe(false);
    });

    it("什么都不传(只有 accountId)→ schema 放行,handler 什么都不做", async () => {
      const acc = await seedAccount(USER, "甲", "bitcoin");

      await call(USER, handleUpdateAccount({ accountId: acc.id }));

      expect(await labels()).toEqual(["甲"]);
    });
  });
});
