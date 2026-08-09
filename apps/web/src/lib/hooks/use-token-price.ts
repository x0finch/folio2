import { useCallback, useRef, useState } from "react";
import { getTokenPrice } from "../server/tokens";

// 选币后自动取市价的共享行为(竞态守卫)。加账户表单与活动录入弹窗共用这一份。
//
// **为什么是个命令式 hook,而不是带动态 key 的 `useQuery`**(#428 片 5 的决定):
// 这次取价是**往一个用户随后可以改的输入框里填一次值**,不是「屏幕上有一处要一直显示这个价」。
// 换成查询之后,缓存里那条数据每次变化都想往回灌,而用户可能早就手改过单价了 —— 于是要么
// 加一堆 `enabled` / 只认第一次的判断把查询的好处关掉,要么就会出现「填好的数字自己变了」。
// 而且这里的取消语义(转手填 symbol、改选别的币、清空)是一个**作废令牌**,不是查询的生命周期。
// 缓存能省的那点重复请求,换不来这些麻烦。
//
// `ticket` 是选币下拉给的那串,原样转发给 server fn —— 本 hook 不解释它。
export function useTokenPrice() {
  const reqRef = useRef(0);
  const [busy, setBusy] = useState(false);

  // 作废还在飞的那次取价:改选别的币、转去手填 symbol、清空选择时用。
  // 不 cancel 的话,先发的那次回来会把后来填的值盖掉。
  const cancel = useCallback(() => {
    reqRef.current++;
    setBusy(false);
  }, []);

  // fetch(ticket, onPrice):停顿期只认最后一次请求,命中才回填,失败静默(手填/沿用即可)。
  const fetchPrice = useCallback(async (ticket: string, onPrice: (unitPrice: number) => void) => {
    const reqId = ++reqRef.current;
    setBusy(true);
    try {
      const p = await getTokenPrice({ data: { ticket } });
      if (reqRef.current === reqId && p?.unitPrice != null) onPrice(p.unitPrice);
    } catch {
      // 取价失败不阻断
    } finally {
      // 只有仍是「最后一次」才收 busy —— 被作废的那次不该把新一轮的 busy 关掉。
      if (reqRef.current === reqId) setBusy(false);
    }
  }, []);

  return { fetchPrice, cancel, busy } as const;
}
