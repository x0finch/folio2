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
    expect(t("Overview.smallHoldings", { n: 4 })).toBe("4 项小额");
  });

  // S1 Settings(#112):外观 / 账户 / 主题选项 / 登出确认新键,中英双语都产出串(非回退 key)。
  it("English: new Settings keys resolve", () => {
    const t = createTranslator({ locale: "en", messages: messages.en });
    expect(t("Settings.account")).toBe("Account");
    expect(t("Settings.appearance")).toBe("Appearance");
    expect(t("Settings.themeSystem")).toBe("System");
    expect(t("Settings.data")).toBe("Data");
    expect(t("Settings.signOutConfirmTitle")).toBe("Sign out?");
  });
  it("Chinese: new Settings keys resolve", () => {
    const t = createTranslator({ locale: "zh", messages: messages.zh });
    expect(t("Settings.account")).toBe("账户");
    expect(t("Settings.appearance")).toBe("外观");
    expect(t("Settings.themeSystem")).toBe("跟随系统");
    expect(t("Settings.data")).toBe("数据");
    expect(t("Settings.signOutConfirmTitle")).toBe("退出登录?");
  });

  // L1 Login(#113):副标题 + read-only 说明新键,中英双语都产出串(非回退 key)。
  it("English: new Login keys resolve", () => {
    const t = createTranslator({ locale: "en", messages: messages.en });
    expect(t("Login.tagline")).toBe("Your self-hosted portfolio, one dashboard.");
    expect(t("Login.readOnlyHint")).toBe(
      "Read-only, Folio never holds your keys or signs transactions.",
    );
  });
  it("Chinese: new Login keys resolve", () => {
    const t = createTranslator({ locale: "zh", messages: messages.zh });
    expect(t("Login.tagline")).toBe("自托管的组合追踪,一个面板看全。");
    expect(t("Login.readOnlyHint")).toBe("只读,Folio 从不持有私钥、不签名交易。");
  });

  // A3 补录凭据(#106):可点击补录提示文案 + modal 补录副标题 + 保存成功 toast,中英双语都产出串(非回退 key)。
  it("English: new credential-completion keys resolve", () => {
    const t = createTranslator({ locale: "en", messages: messages.en });
    expect(t("Accounts.completePrompt")).toBe("Click to add credentials");
    expect(t("Accounts.completeAccountHint")).toBe(
      "Add your read-only API credentials to resume syncing.",
    );
    expect(t("Accounts.credSavedSyncing")).toBe("Saved, syncing…");
  });
  it("Chinese: new credential-completion keys resolve", () => {
    const t = createTranslator({ locale: "zh", messages: messages.zh });
    expect(t("Accounts.completePrompt")).toBe("点击补填凭据");
    expect(t("Accounts.completeAccountHint")).toBe("补填只读 API 凭据以恢复同步。");
    expect(t("Accounts.credSavedSyncing")).toBe("已保存,正在同步…");
  });

  // Passkey 登录 片1(#283,ADR 0028):设置页注册入口 + 登录页 passkey 入口文案,中英双语都产出串。
  it("English: new passkey keys resolve", () => {
    const t = createTranslator({ locale: "en", messages: messages.en });
    expect(t("Settings.passkeys")).toBe("Passkeys");
    expect(t("Settings.addPasskey")).toBe("Add passkey");
    expect(t("Settings.passkeyUnsupported")).toBe("This browser doesn't support passkeys.");
    expect(t("Login.signInWithPasskey")).toBe("Sign in with passkey");
  });
  it("Chinese: new passkey keys resolve", () => {
    const t = createTranslator({ locale: "zh", messages: messages.zh });
    expect(t("Settings.passkeys")).toBe("通行密钥 (Passkey)");
    expect(t("Settings.addPasskey")).toBe("添加 passkey");
    expect(t("Login.signInWithPasskey")).toBe("用 passkey 登录");
  });
});
