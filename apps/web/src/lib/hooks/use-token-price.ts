import { useCallback, useRef, useState } from "react";
import { tokenPrice } from "../server/tokens";

// 选币后自动取市价的共享行为(竞态守卫):Token modal 与 Activity modal 复用。
// fetch(identifier, onPrice):停顿期只认最后一次请求,命中才回填,失败静默(手填/沿用即可)。
export function useTokenPrice() {
  const reqRef = useRef(0);
  const [busy, setBusy] = useState(false);

  const fetchPrice = useCallback(
    async (identifier: string, onPrice: (unitPrice: number) => void) => {
      const reqId = ++reqRef.current;
      setBusy(true);
      try {
        const p = await tokenPrice({ data: { identifier } });
        if (reqRef.current === reqId && p?.unitPrice != null) onPrice(p.unitPrice);
      } catch {
        // 取价失败不阻断
      } finally {
        if (reqRef.current === reqId) setBusy(false);
      }
    },
    [],
  );

  return { busy, fetchPrice } as const;
}
