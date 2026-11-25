import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import {
  handleReplaceAccountCredentials,
  ReplaceCredentialsInput,
} from "@/lib/server/accounts/credentials";
import { handleListAccounts } from "@/lib/server/accounts/list";
import { openCreds } from "@/lib/server/creds";
import { db } from "../_kit/db";
import { fakeRegistry, realRegistry, validateFails } from "../_kit/fakes";
import { blockOutbound } from "../_kit/outbound";
import { callWithRegistry, callWithRegistryExit } from "../_kit/run";
import { freshUser, otherUser } from "../_kit/user";

describe("accounts/credentials", () => {
  // Validate → seal → write; a bad failure path would lock users out of their own account.
  const USER = "h-acc-creds";

  const rawOf = async (userId: string, accountId: string) =>
    (await db(userId).accounts.getRawCreds(accountId)) ?? "";

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
    it("completing missing creds → needsCredentials flag clears", async () => {
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

    it("re-entering only the secret is judged with the kept key, which stays stored", async () => {
      const { account } = await seedIncomplete(USER);
      const real = await realRegistry();
      const { registry, validated } = await fakeRegistry({
        // The real shape gate, without the network probe.
        validate: (connectorId, values) => real.validate(connectorId, values),
      });
      await callWithRegistry(
        USER,
        registry,
        handleReplaceAccountCredentials({
          accountId: account.id,
          creds: { apiKey: "新的 key", secret: "旧的 secret" },
        }),
      );

      await callWithRegistry(
        USER,
        registry,
        handleReplaceAccountCredentials({
          accountId: account.id,
          creds: { secret: "新的 secret" },
        }),
      );

      expect(validated.at(-1)).toEqual({ apiKey: "新的 key", secret: "新的 secret" });
      const opened = await openCreds(
        registry.specs.binance ?? [],
        JSON.parse(await rawOf(USER, account.id)),
        env.SECRETS_KEY as string,
      );
      expect(opened).toMatchObject({ apiKey: "新的 key", secret: "新的 secret" });
    });

    it("replacing the key → new one stored, nothing of the old remains", async () => {
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
      expect(raw).not.toContain("新的 secret"); // secret is encrypted
      const opened = await openCreds(
        registry.specs.binance ?? [],
        JSON.parse(raw),
        env.SECRETS_KEY as string,
      );
      expect(opened.secret).toBe("新的 secret");
    });

    it("new key fails probe → old creds kept intact, user not locked out", async () => {
      // A clear-then-write implementation would leave an account with empty creds here.
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

    it("unknown account → rejected, nothing created", async () => {
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

    it("someone else's account → rejected, their creds untouched", async () => {
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

    it("field the connector doesn't define → not sealed", async () => {
      // Seal follows the spec's fields only; unknown keys would leave `safeView` guessing.
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

    it("manual account (all-public creds) → still validated", async () => {
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

      expect(validated).toHaveLength(1); // validate was called
    });

    it("cred values with surrounding spaces → trimmed by schema before sealing", () => {
      const parsed = ReplaceCredentialsInput.parse({
        accountId: "a",
        creds: { apiKey: "  k  " },
      });
      expect(parsed.creds.apiKey).toBe("k");
    });

    it("empty accountId → schema rejects", () => {
      expect(ReplaceCredentialsInput.safeParse({ accountId: "", creds: {} }).success).toBe(false);
    });
  });
});

describe("accounts/credentials: custom source", () => {
  const USER = "h-acc-creds-custom";
  const configAt = (host: string, path = "/v1/holdings", auth = "bearer") =>
    JSON.stringify({ host, path, auth, fields: { symbol: "s", amount: "a" } });

  const rawOf = async (accountId: string) =>
    JSON.parse((await db(USER).accounts.getRawCreds(accountId)) ?? "{}") as Record<string, string>;

  // Through the real registry: its `keepsSecrets` is what decides.
  const seed = async () => {
    const { registry } = await fakeRegistry();
    const account = await db(USER).accounts.create({
      connectorId: "custom",
      label: "金库",
      creds: "{}",
    });
    await callWithRegistry(
      USER,
      registry,
      handleReplaceAccountCredentials({
        accountId: account.id,
        creds: { config: configAt("api.vault.example"), apiKey: "旧 key" },
      }),
    );
    return { account, registry };
  };

  beforeEach(async () => {
    blockOutbound();
    await freshUser(USER);
  });

  it("changing the host clears the stored key", async () => {
    const { account, registry } = await seed();
    expect((await rawOf(account.id)).apiKey).toBeDefined();

    await callWithRegistry(
      USER,
      registry,
      handleReplaceAccountCredentials({
        accountId: account.id,
        creds: { config: configAt("api.other.example", "/v1/holdings", "none") },
      }),
    );

    const raw = await rawOf(account.id);
    expect(raw.apiKey).toBeUndefined();
    expect(JSON.parse(raw.config).host).toBe("api.other.example");
  });

  it("a keyed config on a new host without a new key is refused, nothing written", async () => {
    const { account } = await seed();
    const before = await rawOf(account.id);
    // The real check (the custom probe sends no request), so the refusal is the app's own.
    const { registry } = await fakeRegistry({ validate: (await realRegistry()).validate });

    const exit = await callWithRegistryExit(
      USER,
      registry,
      handleReplaceAccountCredentials({
        accountId: account.id,
        creds: { config: configAt("api.other.example") },
      }),
    );

    expect(exit._tag).toBe("Failure");
    expect(String(exit)).toContain("API Key: required by this config");
    expect(await rawOf(account.id)).toEqual(before);
  });

  it("a keyed config with no stored key lists as needing credentials", async () => {
    const { registry } = await fakeRegistry();
    const account = await db(USER).accounts.create({
      connectorId: "custom",
      label: "imported",
      creds: JSON.stringify({ config: configAt("api.vault.example") }),
    });
    const keyless = await db(USER).accounts.create({
      connectorId: "custom",
      label: "keyless",
      creds: JSON.stringify({ config: configAt("api.vault.example", "/v1/holdings", "none") }),
    });

    const listed = await callWithRegistry(USER, registry, handleListAccounts());
    const needs = Object.fromEntries(listed.map((a) => [a.id, a.needsCredentials]));
    expect(needs[account.id]).toBe(true);
    expect(needs[keyless.id]).toBe(false);
  });

  it("changing only the path keeps the key, still sealed", async () => {
    const { account, registry } = await seed();
    const sealedBefore = (await rawOf(account.id)).apiKey;

    await callWithRegistry(
      USER,
      registry,
      handleReplaceAccountCredentials({
        accountId: account.id,
        creds: { config: configAt("api.vault.example", "/v2/holdings") },
      }),
    );

    const raw = await rawOf(account.id);
    expect(raw.apiKey).toBe(sealedBefore);
    const opened = await openCreds(registry.specs.custom ?? [], raw, env.SECRETS_KEY as string);
    expect(opened.apiKey).toBe("旧 key");
  });

  it("a new host with a new key stores the new key", async () => {
    const { account, registry } = await seed();

    await callWithRegistry(
      USER,
      registry,
      handleReplaceAccountCredentials({
        accountId: account.id,
        creds: { config: configAt("api.other.example"), apiKey: "新 key" },
      }),
    );

    const raw = await rawOf(account.id);
    const opened = await openCreds(registry.specs.custom ?? [], raw, env.SECRETS_KEY as string);
    expect(opened.apiKey).toBe("新 key");
  });

  it("switching to a keyless config on the same host drops the key", async () => {
    const { account, registry } = await seed();

    await callWithRegistry(
      USER,
      registry,
      handleReplaceAccountCredentials({
        accountId: account.id,
        creds: { config: configAt("api.vault.example", "/v1/holdings", "none") },
      }),
    );

    expect((await rawOf(account.id)).apiKey).toBeUndefined();
  });

  it("re-entering only the key keeps the stored config", async () => {
    const { account, registry } = await seed();

    await callWithRegistry(
      USER,
      registry,
      handleReplaceAccountCredentials({ accountId: account.id, creds: { apiKey: "新 key" } }),
    );

    const raw = await rawOf(account.id);
    expect(JSON.parse(raw.config).host).toBe("api.vault.example");
    const listed = await callWithRegistry(USER, registry, handleListAccounts());
    expect(listed[0].credsSafe).not.toHaveProperty("apiKey");
    expect(listed[0].needsCredentials).toBe(false);
  });
});
