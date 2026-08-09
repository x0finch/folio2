import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef } from "react";
import { invalidateFor } from "../queries/refresh";
import { refreshStalePrices } from "../server/prices";

// 价格 SWR 的客户端半边:loader 已用旧价渲染(pricesStale=true 时),这里触发一次服务端批量
// 刷价,成功且确有刷新 → 定向刷新余额相关的读路径,二次展示新价。单飞(每次挂载至多一次),
// 失败静默(旧价仍在,下次进页再试)。
//
// **有意不改成 `useMutation`**(#428 的结论,别再来「顺手统一一下」):
// mutation 的三样好处在这儿一样都用不上 —— 没有用户点的按钮所以 `isPending` 没地方显示;
// 失败本来就该静默,`onError` 接过去也只能空着;单飞由 `fired` ref 表达,比 mutation 状态更直白。
// 这不是「还没轮到它」,是它本来就不是一次用户发起的写。
export function useStalePriceRefresh(pricesStale: boolean | undefined): void {
  const queryClient = useQueryClient();
  const fired = useRef(false);
  useEffect(() => {
    if (!pricesStale || fired.current) return;
    fired.current = true;
    refreshStalePrices()
      .then(({ refreshed }) => {
        if (refreshed > 0) return invalidateFor(queryClient, "prices.refreshed");
      })
      .catch(() => {
        // 静默:限流/网络失败不打扰,展示继续用旧价
      });
  }, [pricesStale, queryClient]);
}
