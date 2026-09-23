import type { Locale } from "./messages";

// 纯逻辑(可单测):定 locale —— 用户选过的优先 → 浏览器语言兜底 → 默认 en。
//
// 两侧都用它:浏览器按 localStorage + `navigator.language` 定界面语言(./locale-preference),
// 服务端拿它校验调用方传来的 locale 参数(法币选项的名字)。所以这里必须保持纯净 ——
// 加一个只有某一侧才有的 import,另一侧就炸。
export const DEFAULT_LOCALE: Locale = "en";

function isLocale(v: string | undefined | null): v is Locale {
  return v === "en" || v === "zh";
}

export function pickLocale(
  chosen: string | undefined | null,
  browserLanguage: string | undefined | null,
): Locale {
  if (isLocale(chosen)) return chosen;
  // 取首个语言标签的主语言子标签;zh* → zh,其余 → 默认。Accept-Language 形状(`zh-CN,zh;q=0.9`)
  // 与 `navigator.language` 形状(`zh-CN`)都收。
  const primary = browserLanguage?.split(",")[0]?.trim().toLowerCase() ?? "";
  if (primary.startsWith("zh")) return "zh";
  return DEFAULT_LOCALE;
}
