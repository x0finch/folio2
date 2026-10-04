import { createTranslator } from "use-intl/core";
import { describe, expect, it } from "vitest";
import { pickLocale } from "@/lib/i18n/detect";
import { messages } from "@/lib/i18n/messages";

describe("pickLocale", () => {
  it("prefers a valid stored choice", () => {
    expect(pickLocale("zh", "en-US,en")).toBe("zh");
    expect(pickLocale("en", "zh-CN")).toBe("en");
  });
  it("falls back to the browser language when no/invalid choice", () => {
    expect(pickLocale(undefined, "zh-CN,zh;q=0.9,en;q=0.8")).toBe("zh");
    expect(pickLocale("bogus", "zh")).toBe("zh");
    expect(pickLocale(undefined, "en-US")).toBe("en");
    // navigator.language 的形状(没有逗号、没有 q 值)
    expect(pickLocale(null, "zh-TW")).toBe("zh");
  });
  it("defaults to en", () => {
    expect(pickLocale(undefined, undefined)).toBe("en");
    expect(pickLocale(null, "")).toBe("en");
  });
});

// 不测 use-intl 本身,测我们的消息:插值 + ICU 复数在中英都产出正确串。
describe("messages (via createTranslator)", () => {
  it("English: ICU plural one/other", () => {
    const t = createTranslator({ locale: "en", messages: messages.en });
    expect(t("Accounts.synced", { count: 1 })).toBe("Synced 1 account.");
    expect(t("Accounts.synced", { count: 3 })).toBe("Synced 3 accounts.");
    expect(t("Common.signOut")).toBe("Sign out");
  });
  it("Chinese: interpolation + no plural distinction", () => {
    const t = createTranslator({ locale: "zh", messages: messages.zh });
    expect(t("Accounts.synced", { count: 3 })).toBe("已同步 3 个账户。");
    expect(t("Overview.smallHoldings", { n: 4 })).toBe("4 项小额");
    expect(t("Settings.passkeyAddedOn", { date: "1月1日" })).toBe("添加于 1月1日");
  });
});
