import { describe, expect, it } from "vitest";
import { pickLocale } from "@/lib/i18n/detect";
import { LOCALE_INIT_SCRIPT } from "@/lib/i18n/locale-preference";

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
  it.each(CASES)("stored=%j, navigator.language=%j: same answer as pickLocale", (stored, lang) => {
    expect(runScript(stored, lang)).toBe(pickLocale(stored, lang));
  });

  it("localStorage unreadable (private mode): still decides by browser language, no throw", () => {
    expect(runScript("en", "zh-CN", true)).toBe("zh");
    expect(runScript("zh", "en-US", true)).toBe("en");
  });
});
