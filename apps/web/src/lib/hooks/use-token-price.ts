import { useCallback, useRef } from "react";
import { getTokenPrice } from "../server/tokens";

// 选币后自动取市价的共享行为(竞态守卫):Activity modal 用。
// fetch(ticket, onPrice):停顿期只认最后一次请求,命中才回填,失败静默(手填/沿用即可)。
// `ticket` 是选币下拉给的那串,原样转发给 server fn —— 本 hook 不解释它。
export function useTokenPrice() {
  const reqRef = useRef(0);

  const fetchPrice = useCallback(async (ticket: string, onPrice: (unitPrice: number) => void) => {
    const reqId = ++reqRef.current;
    try {
      const p = await getTokenPrice({ data: { ticket } });
      if (reqRef.current === reqId && p?.unitPrice != null) onPrice(p.unitPrice);
    } catch {
      // 取价失败不阻断
    }
  }, []);

  return { fetchPrice } as const;
}
