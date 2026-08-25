import { useSuspenseQuery } from "@tanstack/react-query";
import { type SyncAction, SyncStatus } from "@/components/sync-status";
import { usePortfolio } from "@/lib/hooks/use-portfolio";
import { syncStatusQuery } from "@/lib/queries/sync";

// 页头右上角同步入口:绝对定位落到 PageHeader actions 原位(<main> 是定位上下文,top/right 对齐其内距)。
// 同步摘要读自 react-query 缓存(_authed loader 已预取,不额外请求)。需要它的页面自行渲染 <HeaderSync/>
// —— appShell 不再持有;账户页额外传 action 融入右侧 + 段。桌面 hover 面板 /
// 移动 tap 面板由 SyncStatus 自理。
export function HeaderSync({ action }: { action?: SyncAction }) {
  // 按选中的 Portfolio 那一份(ADR 0033)—— 切组合这块跟着变,不再对着别处的账户报数。
  const { selectedId } = usePortfolio();
  const { data: syncStatus } = useSuspenseQuery(syncStatusQuery(selectedId));
  return (
    <div className="absolute top-6 right-4 z-20 lg:right-8">
      <SyncStatus summary={syncStatus} action={action} />
    </div>
  );
}
