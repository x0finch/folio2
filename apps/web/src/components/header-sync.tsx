import { getRouteApi } from "@tanstack/react-router";
import { type SyncAction, SyncStatus } from "./sync-status";

const authedApi = getRouteApi("/_authed");

// 页头右上角同步入口:绝对定位落到 PageHeader actions 原位(<main> 是定位上下文,top/right 对齐其内距)。
// 同步摘要读自 _authed 布局 loader(不额外请求)。需要它的页面自行渲染 <HeaderSync/> —— appShell 不再持有;
// 账户页额外传 action 融入右侧 + 段(见 accounts.tsx)。桌面 hover 面板 / 移动 tap 面板由 SyncStatus 自理。
export function HeaderSync({ action }: { action?: SyncAction }) {
  const { syncStatus } = authedApi.useLoaderData();
  return (
    <div className="absolute top-6 right-4 z-20 lg:right-8">
      <SyncStatus summary={syncStatus} action={action} />
    </div>
  );
}
