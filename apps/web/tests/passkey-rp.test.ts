import { describe, expect, it } from "vitest";
import { derivePasskeyRp, RP_NAME } from "@/lib/server/session/passkey-rp";

// WebAuthn RP 派生(ADR 0028):rpID = host(无端口/协议),origin = 完整 origin(含端口)。
// 自托管跟着各自 BETTER_AUTH_URL 走 —— 这是本特性能便宜自动化的核心测试缝。
describe("derivePasskeyRp", () => {
  it("本地 dev:rpID 去端口,origin 保留端口", () => {
    const rp = derivePasskeyRp("http://localhost:3000");
    expect(rp.rpID).toBe("localhost"); // rpID 不含端口(WebAuthn 规范)
    expect(rp.origin).toBe("http://localhost:3000"); // origin 须含端口,匹配浏览器实际 origin
    expect(rp.rpName).toBe(RP_NAME);
  });

  it("生产域名:rpID = host,origin = https origin", () => {
    const rp = derivePasskeyRp("https://folio.example.com");
    expect(rp.rpID).toBe("folio.example.com");
    expect(rp.origin).toBe("https://folio.example.com");
  });

  it("带路径/末尾斜杠也只取 host 与 origin", () => {
    const rp = derivePasskeyRp("https://folio.example.com/app/");
    expect(rp.rpID).toBe("folio.example.com");
    expect(rp.origin).toBe("https://folio.example.com"); // origin 不含路径
  });

  it("非标准端口:rpID 仍去端口,origin 保端口", () => {
    const rp = derivePasskeyRp("https://tunnel.trycloudflare.com:8443");
    expect(rp.rpID).toBe("tunnel.trycloudflare.com");
    expect(rp.origin).toBe("https://tunnel.trycloudflare.com:8443");
  });
});
