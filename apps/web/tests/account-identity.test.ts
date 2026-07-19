import { describe, expect, it } from "vitest";
import { accountIdentity } from "../src/lib/account-identity";

// 账户卡身份派生(grill Q4):有 name → 主行 name、副行 email;无 name → 主行 email、
// 副行「自托管」标记;皆缺 → 兜底占位。secondary 用 kind 判别,「自托管」文案留给 UI 本地化。
describe("accountIdentity", () => {
  it("有 name + email → 主行 name、副行 email", () => {
    expect(accountIdentity({ name: "Ada Lovelace", email: "ada@folio.dev" })).toEqual({
      primary: "Ada Lovelace",
      secondary: { kind: "email", value: "ada@folio.dev" },
      initial: "A",
    });
  });

  it("无 name(空串)→ 主行回退 email、副行「自托管」", () => {
    expect(accountIdentity({ name: "", email: "ada@folio.dev" })).toEqual({
      primary: "ada@folio.dev",
      secondary: { kind: "selfHosted" },
      initial: "A",
    });
  });

  it("name 为 null → 同样回退 email", () => {
    expect(accountIdentity({ name: null, email: "bob@folio.dev" })).toEqual({
      primary: "bob@folio.dev",
      secondary: { kind: "selfHosted" },
      initial: "B",
    });
  });

  it("有 name 但无 email → 主行 name、副行「自托管」", () => {
    expect(accountIdentity({ name: "Grace", email: "" })).toEqual({
      primary: "Grace",
      secondary: { kind: "selfHosted" },
      initial: "G",
    });
  });

  it("name 与 email 皆缺 → 兜底占位(不抛错)", () => {
    expect(accountIdentity({ name: null, email: null })).toEqual({
      primary: "?",
      secondary: { kind: "selfHosted" },
      initial: "?",
    });
  });

  it("首字母取 primary 首字符并大写;两侧空白先裁", () => {
    expect(accountIdentity({ name: "  zoe  ", email: "z@folio.dev" })).toEqual({
      primary: "zoe",
      secondary: { kind: "email", value: "z@folio.dev" },
      initial: "Z",
    });
  });
});
