import { useTranslations } from "use-intl";

// 价值曲线画不出来时的空态(#444)。
//
// **为什么不画一条平线凑数。** 一个点连不成线;硬画一条水平线是在说「这段时间没变过」,而事实是
// 「只有一个观测点」。那跟 24h 盈亏那边「算不出就显示 `—` 而不是 0」是同一条规矩:不知道的时候
// 别装作知道。
//
// **为什么不留空白。** 空白读作「还没加载出来」或者「这功能坏了」。新建账户第一次同步之后必然
// 落在这里(只有一张快照),而那是个完全正常的状态 —— 说清楚就好。
//
// 只在**确定**只有 0/1 个点时渲染:还在取数的时候什么都不显示,否则会闪一下这句话再被图盖掉。
export function TrendEmpty({ loading }: { loading: boolean }) {
  const t = useTranslations("Overview");
  if (loading) return null;
  return (
    <div className="absolute inset-0 flex items-center justify-center px-6">
      <p className="text-center text-muted-foreground text-xs">{t("trendNeedsSecondSync")}</p>
    </div>
  );
}
