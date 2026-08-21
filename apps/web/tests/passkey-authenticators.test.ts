import { describe, expect, it } from "vitest";
import {
  detectDeviceLabel,
  getAuthenticatorName,
  passkeyKind,
} from "@/routes/_authed/-settings/passkey/passkey-authenticators";

// passkey 列表展示辅助(ADR 0028):aaguid→友好名 + 类型/同步判定,纯函数,核心测试缝。
describe("getAuthenticatorName", () => {
  it("已知 aaguid → 友好名(大小写不敏感)", () => {
    expect(getAuthenticatorName("ea9b8d66-4d01-1d21-3ce4-b6b48cb575d4")).toBe(
      "Google Password Manager",
    );
    expect(getAuthenticatorName("FBFC3007-154E-4ECC-8C0B-6E020557D7BD")).toBe("Apple Passwords");
  });
  it("全零(匿名)aaguid / 空 / 未知 → undefined", () => {
    expect(getAuthenticatorName("00000000-0000-0000-0000-000000000000")).toBeUndefined();
    expect(getAuthenticatorName(null)).toBeUndefined();
    expect(getAuthenticatorName(undefined)).toBeUndefined();
    expect(getAuthenticatorName("not-a-known-aaguid")).toBeUndefined();
  });
});

describe("passkeyKind", () => {
  it("安全钥匙(usb/nfc/ble)优先", () => {
    expect(passkeyKind({ transports: "usb", backedUp: true })).toBe("security-key");
    expect(passkeyKind({ transports: "nfc,hybrid" })).toBe("security-key");
  });
  it("云同步 → synced", () => {
    expect(passkeyKind({ backedUp: true, transports: "internal,hybrid" })).toBe("synced");
  });
  it("跨设备(hybrid,未同步)→ cross-device", () => {
    expect(passkeyKind({ backedUp: false, transports: "hybrid" })).toBe("cross-device");
  });
  it("本机(internal,未同步)→ platform", () => {
    expect(passkeyKind({ backedUp: false, transports: "internal" })).toBe("platform");
  });
  it("无信息 → unknown", () => {
    expect(passkeyKind({})).toBe("unknown");
    expect(passkeyKind({ transports: null, backedUp: null })).toBe("unknown");
  });
});

describe("detectDeviceLabel", () => {
  it("Chrome on macOS(Chrome UA 含 Safari,不能误判成 Safari)", () => {
    const ua =
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";
    expect(detectDeviceLabel(ua)).toBe("Chrome on macOS");
  });
  it("Safari on iOS", () => {
    const ua =
      "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1";
    expect(detectDeviceLabel(ua)).toBe("Safari on iOS");
  });
  it("Edge on Windows(Edge UA 含 Chrome,不能误判成 Chrome)", () => {
    const ua =
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36 Edg/120.0.0.0";
    expect(detectDeviceLabel(ua)).toBe("Edge on Windows");
  });
  it("Firefox on Linux", () => {
    expect(
      detectDeviceLabel("Mozilla/5.0 (X11; Linux x86_64; rv:120.0) Gecko/20100101 Firefox/120.0"),
    ).toBe("Firefox on Linux");
  });
  it("识别不出 → 兜底 Passkey", () => {
    expect(detectDeviceLabel("totally-unknown")).toBe("Passkey");
  });
});
