import { describe, expect, it } from "vitest";
import {
  detectDeviceLabel,
  getAuthenticatorName,
  passkeyKind,
} from "@/routes/_authed/-settings/passkey/passkey-authenticators";

// Passkey list display helpers: aaguid -> friendly name, plus kind/sync classification.
describe("getAuthenticatorName", () => {
  it("known aaguid -> friendly name (case-insensitive)", () => {
    expect(getAuthenticatorName("ea9b8d66-4d01-1d21-3ce4-b6b48cb575d4")).toBe(
      "Google Password Manager",
    );
    expect(getAuthenticatorName("FBFC3007-154E-4ECC-8C0B-6E020557D7BD")).toBe("Apple Passwords");
  });
  it("all-zero (anonymous) aaguid / empty / unknown -> undefined", () => {
    expect(getAuthenticatorName("00000000-0000-0000-0000-000000000000")).toBeUndefined();
    expect(getAuthenticatorName(null)).toBeUndefined();
    expect(getAuthenticatorName(undefined)).toBeUndefined();
    expect(getAuthenticatorName("not-a-known-aaguid")).toBeUndefined();
  });
});

describe("passkeyKind", () => {
  it("security key (usb/nfc/ble) takes precedence", () => {
    expect(passkeyKind({ transports: "usb", backedUp: true })).toBe("security-key");
    expect(passkeyKind({ transports: "nfc,hybrid" })).toBe("security-key");
  });
  it("cloud-synced -> synced", () => {
    expect(passkeyKind({ backedUp: true, transports: "internal,hybrid" })).toBe("synced");
  });
  it("cross-device (hybrid, not synced) -> cross-device", () => {
    expect(passkeyKind({ backedUp: false, transports: "hybrid" })).toBe("cross-device");
  });
  it("local (internal, not synced) -> platform", () => {
    expect(passkeyKind({ backedUp: false, transports: "internal" })).toBe("platform");
  });
  it("no info -> unknown", () => {
    expect(passkeyKind({})).toBe("unknown");
    expect(passkeyKind({ transports: null, backedUp: null })).toBe("unknown");
  });
});

describe("detectDeviceLabel", () => {
  it("Chrome on macOS (Chrome UA contains Safari, must not be read as Safari)", () => {
    const ua =
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";
    expect(detectDeviceLabel(ua)).toBe("Chrome on macOS");
  });
  it("Safari on iOS", () => {
    const ua =
      "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1";
    expect(detectDeviceLabel(ua)).toBe("Safari on iOS");
  });
  it("Edge on Windows (Edge UA contains Chrome, must not be read as Chrome)", () => {
    const ua =
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36 Edg/120.0.0.0";
    expect(detectDeviceLabel(ua)).toBe("Edge on Windows");
  });
  it("Firefox on Linux", () => {
    expect(
      detectDeviceLabel("Mozilla/5.0 (X11; Linux x86_64; rv:120.0) Gecko/20100101 Firefox/120.0"),
    ).toBe("Firefox on Linux");
  });
  it("unrecognized -> falls back to Passkey", () => {
    expect(detectDeviceLabel("totally-unknown")).toBe("Passkey");
  });
});
