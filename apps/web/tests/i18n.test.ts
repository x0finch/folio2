import { createTranslator } from "use-intl/core";
import { describe, expect, it } from "vitest";
import { pickLocale, readLocaleCookie } from "../src/lib/i18n/detect";
import { messages } from "../src/lib/i18n/messages";

describe("readLocaleCookie", () => {
  it("extracts folio_locale from a Cookie header", () => {
    expect(readLocaleCookie("a=1; folio_locale=zh; b=2")).toBe("zh");
    expect(readLocaleCookie("folio_locale=en")).toBe("en");
    expect(readLocaleCookie("other=x")).toBeUndefined();
    expect(readLocaleCookie(null)).toBeUndefined();
  });
});

describe("pickLocale", () => {
  it("prefers a valid cookie", () => {
    expect(pickLocale("zh", "en-US,en")).toBe("zh");
    expect(pickLocale("en", "zh-CN")).toBe("en");
  });
  it("falls back to Accept-Language when no/invalid cookie", () => {
    expect(pickLocale(undefined, "zh-CN,zh;q=0.9,en;q=0.8")).toBe("zh");
    expect(pickLocale("bogus", "zh")).toBe("zh");
    expect(pickLocale(undefined, "en-US")).toBe("en");
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
    expect(t("Overview.withdrawableMargin", { withdrawable: "$1", margin: "$2" })).toBe(
      "可提 $1 · 已用保证金 $2",
    );
  });
});
