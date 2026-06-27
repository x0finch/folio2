import { describe, expect, it } from "vitest";
import { hmacSha256 } from "../src/crypto";

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
