import { beforeEach, describe, expect, it } from "vitest";
import { handleListAccounts } from "@/lib/server/accounts/list";
import { db } from "../_kit/db";
import { fakeRegistry } from "../_kit/fakes";
import { blockOutbound } from "../_kit/outbound";
import { callWithRegistry } from "../_kit/run";
import { freshUser, otherUser } from "../_kit/user";

// 合并进 accounts/index.test.ts 跑(#527 后续件 2):每个 vitest 文件要在 workerd 里
// 重新评估整张 import 图(实测 ~9s/文件),按目录合并把这笔钱只付一次。
describe("accounts/list", () => {
  // #527 · listAccounts
  //
  // 这个 handler 自己那段拼装(把规格 + 存储值算成 needsCredentials / credsSafe)在清单里被点名
  // 「下层有测试、拼装没有」—— 这里补的正是那一段。
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
    it("链上、CEX、手记三种都出现,connectorId 对得上", async () => {
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

    it("CEX 账户填了 apiKey 没填 secret → 标成「凭据不齐」", async () => {
      await db(USER).accounts.create({
        connectorId: "binance",
        label: "币安",
        creds: JSON.stringify({ apiKey: "k" }),
      });

      const rows = await listed();

      expect(rows[0].needsCredentials).toBe(true);
    });

    it("secret 字段一律不出现在返回里,semi 是打码的", async () => {
      // **红线的可执行形式:** 安全投影 = public 原样、semi 打码、secret 丢弃。
      await db(USER).accounts.create({
        connectorId: "binance",
        label: "币安",
        creds: JSON.stringify({ apiKey: "0123456789abcdef", secret: "密文占位" }),
      });

      const rows = await listed();
      const safe = JSON.stringify(rows[0].credsSafe);

      expect(safe).not.toContain("密文占位");
      expect(rows[0].credsSafe).not.toHaveProperty("secret");
      expect(safe).not.toContain("0123456789abcdef"); // semi 不给全值
    });

    it("凭据在库里是坏 JSON → 这一行不带崩整个列表,只是被当成不齐", async () => {
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

      // 现在会抛(JSON.parse 没有兜底)—— 这条钉住的是那个事实,不是我们想要的行为。
      // **待定项(#527):** 坏 JSON 只可能来自迁移或人手改库,概率低;但一行坏数据让整页打不开
      // 是最难查的那种故障。要不要给 parse 加兜底是你的决定。
      await expect(listed()).rejects.toThrow();
    });

    it("creds 是 null(从没填过)→ 算不齐,不抛", async () => {
      await db(USER).accounts.create({ connectorId: "binance", label: "空的", creds: null });

      const rows = await listed();

      expect(rows[0].needsCredentials).toBe(true);
    });

    it("一个账户都没有 → 空数组,不是 null", async () => {
      expect(await listed()).toEqual([]);
    });

    it("归档账户也在列表里(带 archivedAt)", async () => {
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

    it("别人的账户不出现在我的列表里", async () => {
      await db(otherUser(USER)).accounts.create({
        connectorId: "bitcoin",
        label: "他们的",
        creds: null,
      });

      expect(await listed()).toEqual([]);
    });
  });
});
