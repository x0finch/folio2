import type { DetailFormat } from "@folio/detail-block-basic";
import { createContext, useContext } from "react";

// 渲染上下文:把 app-only 的两件事(i18n 翻译、结构化值格式化)注入到通用渲染器与原语,
// 使 @folio/detail-block 不直接依赖 app 的 use-intl / @folio/fx。app 在挂 <BalanceDetail> 时接线。
//   · translate:i18n key → 文案(跟随中英双语)。
//   · format:结构化值 + format 枚举 → 显示串(跟随显示币种 / locale)。
export interface DetailRenderContext {
  translate: (key: string) => string;
  format: (value: number | string, format?: DetailFormat) => string;
}

// 缺省(未包 Provider 时的安全退化):key 原样、值 String 化 —— 不崩、不假装本地化。
const fallback: DetailRenderContext = {
  translate: (key) => key,
  format: (value) => String(value),
};

const DetailContext = createContext<DetailRenderContext>(fallback);

export const DetailContextProvider = DetailContext.Provider;

export function useDetailContext(): DetailRenderContext {
  return useContext(DetailContext);
}
