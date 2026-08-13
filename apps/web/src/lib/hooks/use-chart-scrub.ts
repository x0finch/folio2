import { useState } from "react";
import { useFormatter } from "use-intl";
import type { HistoryPoint } from "../history";

// 划过图表时「上面那个大数字」要顶替成该点的值(片7)。三处头部(首页 hero、资产抽屉、账户抽屉)
// 共用这一段:各自的排版差得远,共用的是「现在划在哪个点上」这件事 + 时间怎么写。
//
// 抽成 hook 而不是包组件:调用方要拿这个点去换自己那套排版里的两三个位置,包一层反而挡路。
export function useChartScrub() {
  const format = useFormatter();
  const [point, setPoint] = useState<HistoryPoint | null>(null);
  return {
    /** 当前划在哪个点上;`null` = 没在划(显示实时值)。 */
    point,
    /** 划到的时间(月日 + 时分)。原来长在 tooltip 的 labelFormatter 里,现在归这里。 */
    label: point
      ? format.dateTime(new Date(point.t), {
          month: "short",
          day: "numeric",
          hour: "2-digit",
          minute: "2-digit",
        })
      : null,
    /** 传给 `<TrendPanel onActive>`。`setState` 本身稳定,不用再包一层 useCallback。 */
    onActive: setPoint,
  };
}
