import { generateSecret } from "@folio/connectors-basic";
import { describe, expect, it } from "vitest";
import {
  categorizeFields,
  type InputSpec,
  isComplete,
  openCreds,
  SEMI_PREFIX,
  safeView,
  sealCreds,
} from "../src/lib/creds";

const key = generateSecret();

// 字段规格(= credentialSpecs() 的形状:只 key+type+label,无 validator)。
const okx: InputSpec[] = [
  { key: "apiKey", type: "semi", label: "API Key" },
  { key: "secret", type: "secret", label: "API Secret" },
  { key: "passphrase", type: "secret", label: "Passphrase" },
];
const onchain: InputSpec[] = [{ key: "address", type: "public", label: "EVM Address" }];

describe("sealCreds / openCreds", () => {
  it("encrypts only secret fields; public/semi stay plaintext; round-trips", async () => {
    const values = { apiKey: "KEY123", secret: "SIGN", passphrase: "PASS" };
    const sealed = await sealCreds(okx, values, key);
    expect(sealed.apiKey).toBe("KEY123"); // semi 明文
    expect(sealed.secret).not.toBe("SIGN"); // secret 密文
    expect(sealed.passphrase).not.toBe("PASS");
    expect(await openCreds(okx, sealed, key)).toEqual(values); // 往返还原
  });

  it("public field stays plaintext", async () => {
    const sealed = await sealCreds(onchain, { address: "0xabc" }, key);
    expect(sealed).toEqual({ address: "0xabc" });
    expect(await openCreds(onchain, sealed, key)).toEqual({ address: "0xabc" });
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
    expect(isComplete(onchain, { address: "0xabc" })).toBe(true); // 仅 public
    expect(isComplete([], {})).toBe(true); // manual 无输入
  });

  it("false when a semi_ placeholder or a secret field is missing (imported)", () => {
    expect(isComplete(okx, { [`${SEMI_PREFIX}apiKey`]: "ABCD…5678" })).toBe(false); // 占位、无真值
    expect(isComplete(okx, { apiKey: "K", secret: "S" })).toBe(false); // 缺 passphrase
  });
});

describe("categorizeFields", () => {
  it("buckets keys by exposure", () => {
    expect(categorizeFields(okx)).toEqual({
      public: [],
      semi: ["apiKey"],
      secret: ["secret", "passphrase"],
    });
    expect(categorizeFields(onchain)).toEqual({ public: ["address"], semi: [], secret: [] });
  });
});
