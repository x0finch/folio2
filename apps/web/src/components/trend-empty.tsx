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
  // 贴**底部左侧**,不居中:这块容器是「图 + 数字浮层」共用的,正中央正是大号金额所在 ——
  // 居中会把这句话压在金额上(浏览器实测,代币抽屉里「One more sync…」直接穿过 $1,326,637.92)。
  // 折线本来画在下半区,把话放在折线该在的地方最自然;右下角留给区间切换(RangeTabs),故靠左。
  return (
    <div className="absolute inset-0 flex items-end pb-2">
      <p className="text-muted-foreground text-xs">{t("trendNeedsSecondSync")}</p>
    </div>
  );
}
