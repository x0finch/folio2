import { describe, expect, it } from "vitest";
import { pickLocale } from "@/lib/i18n/detect";
import { LOCALE_INIT_SCRIPT } from "@/lib/i18n/locale-preference";

// <head> 里那段内联脚本是 `pickLocale(localStorage, navigator.language)` 的**手抄**(内联脚本导不进模块)。
// 两边一旦对不上,症状是首帧 `<html lang>` 与补水后 React 定的语言不同 —— 闪屏那行「准备中」
// 先是一种语言、补水后换成另一种,没有任何报错。所以逐个输入对照着钉住。
function runScript(stored: string | null, language: string | undefined, storageThrows = false) {
  const html = { lang: "" };
  const localStorage = {
    getItem: (key: string) => {
      if (storageThrows) throw new Error("SecurityError");
      return key === "folio_locale" ? stored : null;
    },
  };
  new Function("localStorage", "navigator", "document", LOCALE_INIT_SCRIPT)(
    localStorage,
    { language },
    { documentElement: html },
  );
  return html.lang;
}

const CASES: [stored: string | null, language: string | undefined][] = [
  [null, "zh-CN"],
  [null, "zh"],
  [null, "ZH-tw"],
  [null, "en-US"],
  [null, "fr-FR"],
  [null, ""],
  [null, undefined],
  ["zh", "en-US"],
  ["en", "zh-CN"],
  ["bogus", "zh-CN"],
  ["bogus", "de"],
  ["", "zh-HK"],
];

describe("LOCALE_INIT_SCRIPT", () => {
  it.each(CASES)("stored=%j, navigator.language=%j → 与 pickLocale 同一个答案", (stored, lang) => {
    expect(runScript(stored, lang)).toBe(pickLocale(stored, lang));
  });

  it("localStorage 读不了(隐私模式)→ 照样按浏览器语言定,不抛", () => {
    expect(runScript("en", "zh-CN", true)).toBe("zh");
    expect(runScript("zh", "en-US", true)).toBe("en");
  });
});
