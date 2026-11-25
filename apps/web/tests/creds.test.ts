import { generateSecret } from "@folio/connectors-basic";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  carryOverCreds,
  categorizeFields,
  type InputSpec,
  isComplete,
  openCreds,
  publicValues,
  SEMI_PREFIX,
  safeView,
  sealCreds,
  toInputSpec,
} from "@/lib/server/creds";

const key = generateSecret();

// Field specs in the credentialSpecs() shape: key + type + label, no validator.
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
    expect(sealed.apiKey).toBe("KEY123"); // semi stays plaintext
    expect(sealed.secret).not.toBe("SIGN"); // secret is ciphertext
    expect(sealed.passphrase).not.toBe("PASS");
    expect(await openCreds(okx, sealed, key)).toEqual(values); // round-trips
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
    expect(safeView(okx, sealed)).toEqual({ apiKey: "ABCD…5678" }); // no secret/passphrase
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
    expect(isComplete(onchain, { address: "0xabc" })).toBe(true); // public only
    expect(isComplete([], {})).toBe(true); // manual has no inputs
  });

  it("false when a semi_ placeholder or a secret field is missing (imported)", () => {
    expect(isComplete(okx, { [`${SEMI_PREFIX}apiKey`]: "ABCD…5678" })).toBe(false); // placeholder, no real value
    expect(isComplete(okx, { apiKey: "K", secret: "S" })).toBe(false); // passphrase missing
  });

  it("an optional field the connector needs counts as required", () => {
    const specs: InputSpec[] = [
      { key: "config", type: "public", label: "Config" },
      { key: "apiKey", type: "secret", label: "Key", optional: true },
    ];
    expect(isComplete(specs, { config: "{}" })).toBe(true);
    expect(isComplete(specs, { config: "{}" }, ["apiKey"])).toBe(false);
    expect(isComplete(specs, { config: "{}", apiKey: "sealed" }, ["apiKey"])).toBe(true);
  });
});

describe("optional fields", () => {
  const custom: InputSpec[] = [
    { key: "config", type: "public", label: "Source config" },
    { key: "apiKey", type: "secret", label: "API Key", optional: true },
  ];

  it("optionality is read off the validator", () => {
    const field = (validator: z.ZodType) => ({
      key: "k",
      type: "secret" as const,
      label: "K",
      validator,
    });
    expect(toInputSpec(field(z.string().optional())).optional).toBe(true);
    expect(toInputSpec(field(z.string())).optional).toBeUndefined();
  });

  it("an optional secret doesn't hold back completeness", () => {
    expect(isComplete(custom, { config: "{}" })).toBe(true);
  });
});

describe("carryOverCreds (a creds update)", () => {
  const stored = {
    address: "0xold",
    apiKey: "KEEPME",
    secret: "ciphertext",
    [`${SEMI_PREFIX}apiKey`]: "AB…YZ",
  };
  const specs: InputSpec[] = [{ key: "address", type: "public", label: "A" }, ...okx];

  it("keeps stored non-public fields that weren't given, while allowed", () => {
    const next = carryOverCreds(specs, stored, { address: "0xnew", passphrase: "new" }, true);
    expect(next).toEqual({
      address: "0xnew",
      passphrase: "new",
      apiKey: "KEEPME",
      secret: "ciphertext",
      [`${SEMI_PREFIX}apiKey`]: "AB…YZ",
    });
  });

  it("a given field replaces the stored one and its placeholder", () => {
    const next = carryOverCreds(specs, stored, { apiKey: "NEW" }, true);
    expect(next.apiKey).toBe("NEW");
    expect(next[`${SEMI_PREFIX}apiKey`]).toBeUndefined();
  });

  it("drops every stored non-public field when not allowed", () => {
    expect(carryOverCreds(specs, stored, { address: "0xnew" }, false)).toEqual({
      address: "0xnew",
    });
  });

  it("never carries public fields: the caller passes those in", () => {
    expect(carryOverCreds(specs, stored, {}, true).address).toBeUndefined();
    expect(publicValues(specs, stored)).toEqual({ address: "0xold" });
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
