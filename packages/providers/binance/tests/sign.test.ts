import { describe, expect, it } from "vitest";
import { hmacSha256Hex } from "../src/sign";

describe("hmacSha256Hex", () => {
  // Golden: 与参考实现(openssl dgst -sha256 -hmac)逐位一致 → 验证 Web Crypto HMAC 正确。
  it("matches the reference HMAC-SHA256 hex", async () => {
    const sig = await hmacSha256Hex("test-secret-key", "recvWindow=5000&timestamp=1700000000000");
    expect(sig).toBe("16c69496a5288437b0893cf91c63fde14dfcd1de33cf54ea604cf34148d16595");
  });

  it("is deterministic and 64 hex chars", async () => {
    const a = await hmacSha256Hex("s", "msg");
    const b = await hmacSha256Hex("s", "msg");
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });
});
