import { describe, expect, it } from "vitest";
import { deriveDefaultName } from "@/routes/-login/derive-default-name";

// 注册默认 name(grill Q7):取 email 的 @ 前本地部分,作 Name 输入框 placeholder / 兜底。
// 与 S1 userIdentity 衔接 —— 用户不填名字时身份行显 `ada` 而非整串 `ada@folio.dev`。
describe("deriveDefaultName", () => {
  it("取 @ 前的本地部分", () => {
    expect(deriveDefaultName("ada@folio.dev")).toBe("ada");
  });

  it("无 @ → 原串(用户还在输入中)", () => {
    expect(deriveDefaultName("ada")).toBe("ada");
  });

  it("两侧空白先裁", () => {
    expect(deriveDefaultName("  bob@folio.dev  ")).toBe("bob");
  });

  it("空串 → 空", () => {
    expect(deriveDefaultName("")).toBe("");
  });

  it("多个 @ → 取首段", () => {
    expect(deriveDefaultName("weird@name@folio.dev")).toBe("weird");
  });
});
