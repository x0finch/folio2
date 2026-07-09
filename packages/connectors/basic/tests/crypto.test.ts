import { describe, expect, it } from "vitest";
import { CryptoError, decrypt, encrypt, generateSecret, hmacSha256 } from "../src/crypto";

const KEY = generateSecret();

describe("crypto AES-GCM", () => {
  it("round-trips strings (ascii / unicode / empty)", async () => {
    for (const s of ["hello", "中文与 emoji 🚀✅", ""]) {
      expect(await decrypt(await encrypt(s, KEY), KEY)).toBe(s);
    }
  });

  it("produces a different ciphertext each time (random IV), both decrypt back", async () => {
    const a = await encrypt("same", KEY);
    const b = await encrypt("same", KEY);
    expect(a).not.toBe(b);
    expect(await decrypt(a, KEY)).toBe("same");
    expect(await decrypt(b, KEY)).toBe("same");
  });

  it("fails to decrypt with the wrong key", async () => {
    const other = generateSecret();
    const ct = await encrypt("secret", KEY);
    await expect(decrypt(ct, other)).rejects.toBeInstanceOf(CryptoError);
  });

  it("detects tampering (GCM auth)", async () => {
    const ct = await encrypt("secret", KEY);
    // 改动载荷首字符(IV 区)→ 认证失败
    const tampered = (ct[0] === "A" ? "B" : "A") + ct.slice(1);
    await expect(decrypt(tampered, KEY)).rejects.toBeInstanceOf(CryptoError);
  });

  it("rejects an invalid SECRETS_KEY length", async () => {
    const badKey = "dG9vc2hvcnQ="; // base64("tooshort") = 8 bytes
    await expect(encrypt("x", badKey)).rejects.toBeInstanceOf(CryptoError);
    await expect(decrypt("AAAAAAAAAAAAAAAAAAAA", badKey)).rejects.toBeInstanceOf(CryptoError);
  });

  it("generateSecret yields a usable 32-byte key", async () => {
    const k = generateSecret();
    expect(await decrypt(await encrypt("ok", k), k)).toBe("ok");
  });
});

// Golden: 与参考实现 openssl dgst -sha256 -hmac 逐位一致(hex 与 base64 两种编码)。
const SECRET = "test-secret-key";
const MSG = "okx-prehash";

describe("hmacSha256", () => {
  it("matches openssl HMAC-SHA256 hex", async () => {
    expect(await hmacSha256(SECRET, MSG, "hex")).toBe(
      "fd31ec4486b3b2e28f5ceab3371e9807182e108004054a0df5eb3c764a148b9d",
    );
  });

  it("matches openssl HMAC-SHA256 base64", async () => {
    expect(await hmacSha256(SECRET, MSG, "base64")).toBe(
      "/THsRIazsuKPXOqzNx6YBxguEIAEBUoN9es8dkoUi50=",
    );
  });

  it("is deterministic", async () => {
    expect(await hmacSha256("s", "m", "hex")).toBe(await hmacSha256("s", "m", "hex"));
  });
});
