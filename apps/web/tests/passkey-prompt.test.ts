import { describe, expect, it } from "vitest";
import { shouldPromptForPasskey } from "@/routes/-login/passkey-prompt";

// 登录后引导判定(ADR 0028 / #285):支持 + 未 dismiss + 无 passkey 三者齐才引导。
// localStorage 读写是薄 IO wrapper,不单测(靠浏览器/真机);纯判定是核心测试缝。
describe("shouldPromptForPasskey", () => {
  it("支持 + 未 dismiss + 无 passkey → 引导", () => {
    expect(shouldPromptForPasskey({ supported: true, dismissed: false, passkeyCount: 0 })).toBe(
      true,
    );
  });
  it("已有 passkey → 不引导", () => {
    expect(shouldPromptForPasskey({ supported: true, dismissed: false, passkeyCount: 2 })).toBe(
      false,
    );
  });
  it("已「别再问我」→ 不引导", () => {
    expect(shouldPromptForPasskey({ supported: true, dismissed: true, passkeyCount: 0 })).toBe(
      false,
    );
  });
  it("浏览器不支持 → 不引导", () => {
    expect(shouldPromptForPasskey({ supported: false, dismissed: false, passkeyCount: 0 })).toBe(
      false,
    );
  });
});
