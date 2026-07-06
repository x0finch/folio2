import { useRouter } from "@tanstack/react-router";
import { useEffect, useRef } from "react";
import { refreshStalePrices } from "../server/tokens";

// 价格 SWR 的客户端半边:loader 已用旧价渲染(pricesStale=true 时),这里触发一次服务端批量
// 刷价,成功且确有刷新 → invalidate 重跑 loader 二次展示新价。单飞(每次挂载至多一次),
// 失败静默(旧价仍在,下次进页再试)。
export function useStalePriceRefresh(pricesStale: boolean | undefined): void {
  const router = useRouter();
  const fired = useRef(false);
  useEffect(() => {
    if (!pricesStale || fired.current) return;
    fired.current = true;
    refreshStalePrices()
      .then(({ refreshed }) => {
        if (refreshed > 0) return router.invalidate();
      })
      .catch(() => {
        // 静默:限流/网络失败不打扰,展示继续用旧价
      });
  }, [pricesStale, router]);
}
