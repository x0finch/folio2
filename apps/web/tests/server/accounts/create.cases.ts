import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { CreateAccountInput, handleCreateAccount } from "@/lib/server/accounts/create";
import { handleListAccounts } from "@/lib/server/accounts/list";
import { openCreds } from "@/lib/server/creds";
import { handleGetManualAccount } from "@/lib/server/manual-tokens/get-account";
import { countRows, db } from "../_kit/db";
import { fakeRegistry, validateFails } from "../_kit/fakes";
import { blockOutbound } from "../_kit/outbound";
import { callWithRegistry, callWithRegistryExit, failureOf } from "../_kit/run";
import { freshUser, otherUser } from "../_kit/user";

describe("accounts/create", () => {
  // The only write path that touches both encryption and the network. Only `validate` is faked;
  // field specs stay real since they decide what gets encrypted.
  const USER = "h-acc-create";

  /** Raw stored creds (ciphertext), to assert secrets really are encrypted. */
  const rawCredsOf = async (userId: string, accountId: string) =>
    (await db(userId).accounts.getRawCreds(accountId)) ?? "";

  beforeEach(async () => {
    blockOutbound();
    await freshUser(USER);
    await freshUser(otherUser(USER));
  });

  describe("createAccount", () => {
    it("on-chain address account → listed, creds complete, no secret plaintext returned", async () => {
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
      expect(JSON.stringify(listed[0].credsSafe)).toContain("bc1"); // public fields stay visible
    });

    it("CEX account → secret encrypted at rest, public/semi plaintext", async () => {
      // Asserts the stored row: semi apiKey readable, secret absent as plaintext yet decrypts back.
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

    it("manual account → token declaration and opening activity are both written", async () => {
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
      // `manual_activity` has no user_id column (owned via accountId), so count via the details.
      const detail = await callWithRegistry(
        USER,
        registry,
        handleGetManualAccount({ accountId: account.id }),
      );
      expect(detail.tokens).toHaveLength(1);
      expect(detail.activities).toHaveLength(1);
    });

    it("with portfolioId → filed under that portfolio, not the default", async () => {
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

    it("bad address / fake key → probe fails, nothing written, message reaches the frontend", async () => {
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
      // Typed failure, not a defect: the frontend gets this message, not a FiberFailure.
      expect((failureOf(exit) as Error | undefined)?.message).toContain("这个地址不对");
      expect(await countRows("accounts", USER)).toBe(0);
      expect(await callWithRegistry(USER, registry, handleListAccounts())).toEqual([]);
    });

    it("empty optional field → treated as unset, not sealed", async () => {
      // A stored empty string would count as "filled" in `isComplete` and sync would use an empty key.
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

    it("same address twice → two independent accounts, no overwrite", async () => {
      // Pins current behaviour: no uniqueness constraint.
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

    it("someone else's portfolioId → account not filed under it", async () => {
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

    it("empty / whitespace label or empty connectorId → schema rejects", () => {
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

    it("label with surrounding spaces → trimmed by schema before write", () => {
      expect(
        CreateAccountInput.parse({ connectorId: "bitcoin", label: "  冷钱包 ", values: {} }).label,
      ).toBe("冷钱包");
    });
  });
});
