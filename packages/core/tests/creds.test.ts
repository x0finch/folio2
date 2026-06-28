import { describe, expect, it } from "vitest";
import { z } from "zod";
import { isComplete, openCreds, SEMI_PREFIX, safeView, sealCreds } from "../src/creds";
import { generateSecret } from "../src/crypto";
import type { ProviderInput } from "../src/provider";

const key = generateSecret();

const okx: ProviderInput[] = [
  { key: "apiKey", type: "semi", label: "API Key", validator: z.string().min(1) },
  { key: "secret", type: "secret", label: "API Secret", validator: z.string().min(1) },
  { key: "passphrase", type: "secret", label: "Passphrase", validator: z.string().min(1) },
];
const onchain: ProviderInput[] = [
  { key: "identifier", type: "public", label: "EVM Address", validator: z.string().min(1) },
];

describe("sealCreds / openCreds", () => {
  it("encrypts only secret fields; public/semi stay plaintext; round-trips", async () => {
    const values = { apiKey: "KEY123", secret: "SIGN", passphrase: "PASS" };
    const sealed = await sealCreds(okx, values, key);
    // semi(apiKey)明文;secret/passphrase 密文(≠ 原值)。
    expect(sealed.apiKey).toBe("KEY123");
    expect(sealed.secret).not.toBe("SIGN");
    expect(sealed.passphrase).not.toBe("PASS");
    // 往返还原。
    expect(await openCreds(okx, sealed, key)).toEqual(values);
  });

  it("public field stays plaintext", async () => {
    const sealed = await sealCreds(onchain, { identifier: "0xabc" }, key);
    expect(sealed).toEqual({ identifier: "0xabc" });
    expect(await openCreds(onchain, sealed, key)).toEqual({ identifier: "0xabc" });
  });
});

describe("safeView (export / hint projection)", () => {
  it("keeps public whole, masks semi, drops secret", async () => {
    const sealed = await sealCreds(
      okx,
      { apiKey: "ABCD1234WXYZ5678", secret: "S", passphrase: "P" },
      key,
    );
    expect(safeView(okx, sealed)).toEqual({ apiKey: "ABCD…5678" }); // 无 secret/passphrase
  });

  it("passes through a semi_ placeholder (imported needs-creds account)", () => {
    const stored = { [`${SEMI_PREFIX}apiKey`]: "ABCD…5678" };
    expect(safeView(okx, stored)).toEqual({ apiKey: "ABCD…5678" });
  });
});

describe("isComplete (needs-credentials)", () => {
  it("true when every non-public field has a real value", async () => {
    const sealed = await sealCreds(okx, { apiKey: "K", secret: "S", passphrase: "P" }, key);
    expect(isComplete(okx, sealed)).toBe(true);
    expect(isComplete(onchain, { identifier: "0xabc" })).toBe(true); // 仅 public
    expect(isComplete([], {})).toBe(true); // manual 无输入
  });

  it("false when a semi_ placeholder or a secret field is missing (imported)", () => {
    expect(isComplete(okx, { [`${SEMI_PREFIX}apiKey`]: "ABCD…5678" })).toBe(false); // 占位、无真值
    expect(isComplete(okx, { apiKey: "K", secret: "S" })).toBe(false); // 缺 passphrase
  });
});
