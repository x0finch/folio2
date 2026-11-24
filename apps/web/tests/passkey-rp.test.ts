import { describe, expect, it } from "vitest";
import { derivePasskeyRp, RP_NAME } from "@/lib/server/session/passkey-rp";

// WebAuthn RP derivation: rpID = host (no port/scheme), origin = full origin (with port). Each
// self-hosted instance follows its own BETTER_AUTH_URL.
describe("derivePasskeyRp", () => {
  it("local dev: rpID drops the port, origin keeps it", () => {
    const rp = derivePasskeyRp("http://localhost:3000");
    expect(rp.rpID).toBe("localhost"); // rpID excludes the port (WebAuthn spec)
    expect(rp.origin).toBe("http://localhost:3000"); // origin keeps the port, like the browser's
    expect(rp.rpName).toBe(RP_NAME);
  });

  it("production domain: rpID = host, origin = https origin", () => {
    const rp = derivePasskeyRp("https://folio.example.com");
    expect(rp.rpID).toBe("folio.example.com");
    expect(rp.origin).toBe("https://folio.example.com");
  });

  it("path / trailing slash -> still only host and origin", () => {
    const rp = derivePasskeyRp("https://folio.example.com/app/");
    expect(rp.rpID).toBe("folio.example.com");
    expect(rp.origin).toBe("https://folio.example.com"); // origin excludes the path
  });

  it("non-standard port: rpID drops it, origin keeps it", () => {
    const rp = derivePasskeyRp("https://tunnel.trycloudflare.com:8443");
    expect(rp.rpID).toBe("tunnel.trycloudflare.com");
    expect(rp.origin).toBe("https://tunnel.trycloudflare.com:8443");
  });
});
