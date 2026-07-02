import { describe, expect, it } from "vitest";
import { CryptoError, decrypt, encrypt, generateSecret } from "../src/crypto";

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
