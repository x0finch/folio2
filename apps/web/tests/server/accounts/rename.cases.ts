import { beforeEach, describe, expect, it } from "vitest";
import { handleListAccounts } from "@/lib/server/accounts/list";
import { handleRenameAccount, RenameAccountInput } from "@/lib/server/accounts/rename";
import { db } from "../_kit/db";
import { fakeRegistry } from "../_kit/fakes";
import { blockOutbound } from "../_kit/outbound";
import { call, callExit, callWithRegistry } from "../_kit/run";
import { seedAccount } from "../_kit/seed";
import { freshUser, otherUser } from "../_kit/user";

describe("accounts/rename", () => {
  const USER = "h-acc-rename";

  const labels = async () => {
    const { registry } = await fakeRegistry();
    const rows = await callWithRegistry(USER, registry, handleListAccounts());
    return rows.map((r) => r.label);
  };

  beforeEach(async () => {
    blockOutbound();
    await freshUser(USER);
    await freshUser(otherUser(USER));
  });

  describe("renameAccount", () => {
    it("改名 → 列表里是新名字", async () => {
      const acc = await seedAccount(USER, "旧名", "bitcoin");

      await call(USER, handleRenameAccount({ accountId: acc.id, label: "新名" }));

      expect(await labels()).toEqual(["新名"]);
    });

    it("改别人的账户 → 对方那个名字没变", async () => {
      const theirs = await seedAccount(otherUser(USER), "他们的", "bitcoin");

      await callExit(USER, handleRenameAccount({ accountId: theirs.id, label: "被我改了" }));

      expect((await db(otherUser(USER)).accounts.getById(theirs.id))?.label).toBe("他们的");
    });

    it("名字改成空串 / 纯空格 → schema 拒", () => {
      expect(RenameAccountInput.safeParse({ accountId: "a", label: "" }).success).toBe(false);
      expect(RenameAccountInput.safeParse({ accountId: "a", label: "  " }).success).toBe(false);
    });
  });
});
