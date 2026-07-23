import { useMemo } from "react";
import { useLocale } from "use-intl";

// manual 活动时间按**浏览器本地时区**格式化。全站 useFormatter 锁 UTC(__root IntlProvider timeZone="UTC"),
// 而 manual 活动是用户输入的墙钟时间,按本地显示才与 DateTimeWheel 的本地读写一致。集中此决定,避免各处
// 手搓 Intl.DateTimeFormat 重复、也防新面误用全站 UTC formatter 而漂移。
// options 须为稳定引用(模块级常量),以便 useMemo 依赖稳定。
export function useLocalDateFormat(options: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
  const locale = useLocale();
  return useMemo(() => new Intl.DateTimeFormat(locale, options), [locale, options]);
}
