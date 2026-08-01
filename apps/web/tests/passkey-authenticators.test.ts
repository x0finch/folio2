import { describe, expect, it } from "vitest";
import { getAuthenticatorName, passkeyKind } from "../src/lib/passkey-authenticators";

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
