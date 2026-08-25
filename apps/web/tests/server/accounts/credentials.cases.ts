import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import {
  handleReplaceAccountCredentials,
  ReplaceCredentialsInput,
} from "@/lib/server/accounts/credentials";
import { handleListAccounts } from "@/lib/server/accounts/list";
import { openCreds } from "@/lib/server/creds";
import { db } from "../_kit/db";
import { fakeRegistry, validateFails } from "../_kit/fakes";
import { blockOutbound } from "../_kit/outbound";
import { callWithRegistry, callWithRegistryExit } from "../_kit/run";
import { freshUser, otherUser } from "../_kit/user";

// 合并进 accounts/index.test.ts 跑(#527 后续件 2):每个 vitest 文件要在 workerd 里
// 重新评估整张 import 图(实测 ~9s/文件),按目录合并把这笔钱只付一次。
describe("accounts/credentials", () => {
  // #527 · replaceAccountCredentials
  //
  // **清单里唯一被标成「值得紧张」的那个 handler**,而在这之前它一条测试都没有:四步
  // (取账户 → 探活 → 加密 → 落库),碰凭据加密,而失败分支决定用户会不会被锁在自己账户外面。
  const USER = "h-acc-creds";

  const rawOf = async (userId: string, accountId: string) =>
    (await db(userId).accounts.getRawCreds(accountId)) ?? "";

  /** 建一个缺凭据的 CEX 账户(只填了 apiKey,没有 secret)。 */
  const seedIncomplete = async (userId: string) => {
    const { registry } = await fakeRegistry();
    const account = await db(userId).accounts.create({
      connectorId: "binance",
      label: "币安",
      creds: JSON.stringify({ apiKey: "旧的 key" }),
    });
    return { account, registry };
  };

  beforeEach(async () => {
    blockOutbound();
    await freshUser(USER);
    await freshUser(otherUser(USER));
  });

  describe("replaceAccountCredentials", () => {
    it("给缺凭据的账户补齐 → 「凭据不齐」的标记消失", async () => {
      const { account, registry } = await seedIncomplete(USER);
      expect(
        (await callWithRegistry(USER, registry, handleListAccounts()))[0].needsCredentials,
      ).toBe(true);

      await callWithRegistry(
        USER,
        registry,
        handleReplaceAccountCredentials({
          accountId: account.id,
          creds: { apiKey: "新的 key", secret: "新的 secret" },
        }),
      );

      const listed = await callWithRegistry(USER, registry, handleListAccounts());
      expect(listed[0].needsCredentials).toBe(false);
    });

    it("换一把新 key → 落库的是新的,旧的不留残留", async () => {
      const { account, registry } = await seedIncomplete(USER);

      await callWithRegistry(
        USER,
        registry,
        handleReplaceAccountCredentials({
          accountId: account.id,
          creds: { apiKey: "新的 key", secret: "新的 secret" },
        }),
      );

      const raw = await rawOf(USER, account.id);
      expect(raw).toContain("新的 key");
      expect(raw).not.toContain("旧的 key");
      expect(raw).not.toContain("新的 secret"); // secret 是加密的
      const opened = await openCreds(
        registry.specs.binance ?? [],
        JSON.parse(raw),
        env.SECRETS_KEY as string,
      );
      expect(opened.secret).toBe("新的 secret");
    });

    it("新 key 探活失败 → 旧凭据必须原样保留,不能先删后写把人锁在外面", async () => {
      // **这条是这个文件存在的理由。** 「先清空再写」的实现在探活失败时会留下一个空凭据的账户:
      // 用户既同步不了,也看不出原来那把 key 还在不在。
      const { account } = await seedIncomplete(USER);
      const before = await rawOf(USER, account.id);
      const { registry } = await fakeRegistry({ validate: validateFails("这把 key 无效") });

      const exit = await callWithRegistryExit(
        USER,
        registry,
        handleReplaceAccountCredentials({
          accountId: account.id,
          creds: { apiKey: "坏的", secret: "坏的" },
        }),
      );

      expect(exit._tag).toBe("Failure");
      expect(await rawOf(USER, account.id)).toBe(before);
    });

    it("账户不存在 → 拒,而且不凭空建一条", async () => {
      const { registry } = await fakeRegistry();

      const exit = await callWithRegistryExit(
        USER,
        registry,
        handleReplaceAccountCredentials({
          accountId: "没有这个",
          creds: { apiKey: "k", secret: "s" },
        }),
      );

      expect(exit._tag).toBe("Failure");
      expect(await callWithRegistry(USER, registry, handleListAccounts())).toEqual([]);
    });

    it("账户是别人的 → 拒,对方那份凭据一个字节没动", async () => {
      const theirs = await seedIncomplete(otherUser(USER));
      const before = await rawOf(otherUser(USER), theirs.account.id);
      const { registry } = await fakeRegistry();

      const exit = await callWithRegistryExit(
        USER,
        registry,
        handleReplaceAccountCredentials({
          accountId: theirs.account.id,
          creds: { apiKey: "我的", secret: "我的" },
        }),
      );

      expect(exit._tag).toBe("Failure");
      expect(await rawOf(otherUser(USER), theirs.account.id)).toBe(before);
    });

    it("传了这个 connector 没有的字段名 → 不混进加密那份里", async () => {
      // seal 只按规格里的字段走,多出来的键会被丢掉 —— 否则库里会长出一堆没人认识的键,
      // 而 `safeView` 也不知道该怎么处理它们(该打码还是该丢?)。
      const { account, registry } = await seedIncomplete(USER);

      await callWithRegistry(
        USER,
        registry,
        handleReplaceAccountCredentials({
          accountId: account.id,
          creds: { apiKey: "k", secret: "s", 我乱加的字段: "危险" },
        }),
      );

      expect(await rawOf(USER, account.id)).not.toContain("我乱加的字段");
    });

    it("手记账户(凭据全是 public)→ 也走同一条路,不因为「不敏感」就跳过校验", async () => {
      const { registry, validated } = await fakeRegistry();
      const account = await db(USER).accounts.create({
        connectorId: "manual",
        label: "手记",
        creds: JSON.stringify({ tokens: "[]" }),
      });

      await callWithRegistry(
        USER,
        registry,
        handleReplaceAccountCredentials({
          accountId: account.id,
          creds: { tokens: JSON.stringify([{ symbol: "BTC", unitPrice: 1, amount: 1 }]) },
        }),
      );

      expect(validated).toHaveLength(1); // 校验被调过
    });

    it("凭据值两头带空格 → schema trim 之后才 seal", () => {
      const parsed = ReplaceCredentialsInput.parse({
        accountId: "a",
        creds: { apiKey: "  k  " },
      });
      expect(parsed.creds.apiKey).toBe("k");
    });

    it("accountId 空串 → schema 拒", () => {
      expect(ReplaceCredentialsInput.safeParse({ accountId: "", creds: {} }).success).toBe(false);
    });
  });
});
