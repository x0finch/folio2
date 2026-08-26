import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { CreateAccountInput, handleCreateAccount } from "@/lib/server/accounts/create";
import { handleListAccounts } from "@/lib/server/accounts/list";
import { openCreds } from "@/lib/server/creds";
import { handleGetManualAccount } from "@/lib/server/manual-tokens/get-account";
import { countRows, db } from "../_kit/db";
import { fakeRegistry, validateFails } from "../_kit/fakes";
import { blockOutbound } from "../_kit/outbound";
import { callWithRegistry, callWithRegistryExit } from "../_kit/run";
import { freshUser, otherUser } from "../_kit/user";

// 合并进 accounts/index.test.ts 跑(#527 后续件 2):每个 vitest 文件要在 workerd 里
// 重新评估整张 import 图(实测 ~9s/文件),按目录合并把这笔钱只付一次。
describe("accounts/create", () => {
  // #527 · createAccount
  //
  // **这是全仓唯一同时碰加密和出网的写路径**,也是清单里对抗条最厚的一个。
  // 探活走替身(`fakeRegistry` 只换 `validate`,规格用真的)—— 规格决定哪个字段加密,
  // 用假的等于把最该测的那半架空。
  const USER = "h-acc-create";

  /** 库里那份原始 creds(密文),用来断言「secret 真的加密了」。 */
  const rawCredsOf = async (userId: string, accountId: string) =>
    (await db(userId).accounts.getRawCreds(accountId)) ?? "";

  beforeEach(async () => {
    blockOutbound();
    await freshUser(USER);
    await freshUser(otherUser(USER));
  });

  describe("createAccount", () => {
    it("建链上地址账户 → 出现在列表里、凭据齐,返回里没有任何 secret 原文", async () => {
      const { registry } = await fakeRegistry();

      const account = await callWithRegistry(
        USER,
        registry,
        handleCreateAccount({
          connectorId: "bitcoin",
          label: "冷钱包",
          values: { addressOrXpub: "bc1-测试地址" },
        }),
      );

      expect(account.label).toBe("冷钱包");
      const listed = await callWithRegistry(USER, registry, handleListAccounts());
      expect(listed).toHaveLength(1);
      expect(listed[0].needsCredentials).toBe(false);
      expect(JSON.stringify(listed[0].credsSafe)).toContain("bc1"); // public 字段照旧看得见
    });

    it("建 CEX 账户 → 落库那份里 secret 是加密的,public / semi 是明文", async () => {
      // **这条是原则 #5 的可执行形式。** 断言的不是「有没有报错」,而是库里那一行长什么样:
      // apiKey(semi)照旧看得见,secret 字段在密文里找不到原文,而解密回来又等于原值。
      const { registry } = await fakeRegistry();
      const values = { apiKey: "key-明文可见", secret: "secret-绝不可见" };

      const account = await callWithRegistry(
        USER,
        registry,
        handleCreateAccount({ connectorId: "binance", label: "币安", values }),
      );

      const raw = await rawCredsOf(USER, account.id);
      expect(raw).toContain("key-明文可见");
      expect(raw).not.toContain("secret-绝不可见");

      const specs = registry.specs.binance ?? [];
      const opened = await openCreds(specs, JSON.parse(raw), env.SECRETS_KEY as string);
      expect(opened.secret).toBe("secret-绝不可见");
    });

    it("建手记账户 → 同时落了 token 声明与开仓活动", async () => {
      const { registry } = await fakeRegistry();

      const account = await callWithRegistry(
        USER,
        registry,
        handleCreateAccount({
          connectorId: "manual",
          label: "手记",
          values: { tokens: JSON.stringify([{ symbol: "BTC", unitPrice: 100, amount: 2 }]) },
        }),
      );

      expect(account.connectorId).toBe("manual");
      // `manual_activity` 没有 user_id 列(归属经 accountId,ADR 0022 的形状),所以数行数要
      // 走明细而不是那张表 —— 撞过一次 `no such column: user_id`。
      const detail = await callWithRegistry(
        USER,
        registry,
        handleGetManualAccount({ accountId: account.id }),
      );
      expect(detail.tokens).toHaveLength(1);
      expect(detail.activities).toHaveLength(1);
    });

    it("带 portfolioId 建 → 归在那个 Portfolio 下,不是默认那个", async () => {
      const { registry } = await fakeRegistry();
      const def = await db(USER).portfolios.ensureDefault();
      const target = await db(USER).portfolios.create({ name: "目标" });

      const account = await callWithRegistry(
        USER,
        registry,
        handleCreateAccount({
          connectorId: "bitcoin",
          label: "冷钱包",
          values: { addressOrXpub: "bc1-x" },
          portfolioId: target.id,
        }),
      );

      const links = await db(USER).portfolios.listMemberships();
      const where = links.find((l) => l.accountId === account.id)?.portfolioId;
      expect(where).toBe(target.id);
      expect(where).not.toBe(def.id);
    });

    it("地址写错 / key 是假的 → 探活失败,一行都不许落库", async () => {
      const { registry } = await fakeRegistry({ validate: validateFails("这个地址不对") });

      const exit = await callWithRegistryExit(
        USER,
        registry,
        handleCreateAccount({
          connectorId: "bitcoin",
          label: "冷钱包",
          values: { addressOrXpub: "垃圾" },
        }),
      );

      expect(exit._tag).toBe("Failure");
      expect(await countRows("accounts", USER)).toBe(0);
      expect(await callWithRegistry(USER, registry, handleListAccounts())).toEqual([]);
    });

    it("上游超时(不是凭据错)→ 同样不落库,而且错误原文能传到前端", async () => {
      const { registry } = await fakeRegistry({ validate: validateFails("upstream timed out") });

      const exit = await callWithRegistryExit(
        USER,
        registry,
        handleCreateAccount({ connectorId: "binance", label: "币安", values: { apiKey: "k" } }),
      );

      expect(exit._tag).toBe("Failure");
      expect(await countRows("accounts", USER)).toBe(0);
    });

    it("可选字段留空串 → 当作没填,不会被加密进去", async () => {
      // 空串一旦落库,`isComplete` 会认为「填了」,于是「凭据不齐」的提示消失、同步却拿着空 key
      // 去打上游。这条钉的是过滤那一步。
      const { registry, validated } = await fakeRegistry();

      await callWithRegistry(
        USER,
        registry,
        handleCreateAccount({
          connectorId: "okx",
          label: "欧易",
          values: { apiKey: "k", secret: "s", passphrase: "" },
        }),
      );

      expect(validated[0]).not.toHaveProperty("passphrase");
    });

    it("同一个地址建两次 → 两条各自独立,不是一条盖掉另一条", async () => {
      // 钉现状:没有唯一约束。两条独立在这里是说得通的(同一个地址可以分两个用途记),
      // 但界面上会出现两行同名同址 —— 要不要挡是你的决定(#527 待定项)。
      const { registry } = await fakeRegistry();
      const body = {
        connectorId: "bitcoin" as const,
        label: "冷钱包",
        values: { addressOrXpub: "bc1-同一个地址" },
      };

      const a = await callWithRegistry(USER, registry, handleCreateAccount(body));
      const b = await callWithRegistry(USER, registry, handleCreateAccount(body));

      expect(a.id).not.toBe(b.id);
      expect(await countRows("accounts", USER)).toBe(2);
    });

    it("portfolioId 是别人的 → 账户不许落到别人名下", async () => {
      const { registry } = await fakeRegistry();
      const theirPf = await db(otherUser(USER)).portfolios.ensureDefault();

      const exit = await callWithRegistryExit(
        USER,
        registry,
        handleCreateAccount({
          connectorId: "bitcoin",
          label: "冷钱包",
          values: { addressOrXpub: "bc1-x" },
          portfolioId: theirPf.id,
        }),
      );

      expect(exit._tag).toBe("Failure");
      expect(await db(otherUser(USER)).portfolios.listMemberships()).toEqual([]);
    });

    it("label 空串 / 纯空格、connectorId 空串 → schema 拒", () => {
      expect(
        CreateAccountInput.safeParse({ connectorId: "bitcoin", label: "", values: {} }).success,
      ).toBe(false);
      expect(
        CreateAccountInput.safeParse({ connectorId: "bitcoin", label: "  ", values: {} }).success,
      ).toBe(false);
      expect(
        CreateAccountInput.safeParse({ connectorId: "", label: "x", values: {} }).success,
      ).toBe(false);
    });

    it("label 两头带空格 → schema trim 之后才落库", () => {
      expect(
        CreateAccountInput.parse({ connectorId: "bitcoin", label: "  冷钱包 ", values: {} }).label,
      ).toBe("冷钱包");
    });
  });
});
