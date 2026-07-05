import { SidebarInset, SidebarProvider, SidebarTrigger } from "@folio/ui";
import { createFileRoute, Outlet, redirect } from "@tanstack/react-router";
import { AppSidebar } from "../components/app-sidebar";
import { fetchCurrentUser } from "../lib/server/session";

// 受保护布局:无 session 则重定向到 /login(仅 UX;数据安全靠各 authedServerFn)。
export const Route = createFileRoute("/_authed")({
  beforeLoad: async () => {
    const current = await fetchCurrentUser();
    if (!current) throw redirect({ to: "/login" });
    return { user: current.user };
  },
  component: AuthedLayout,
});

function AuthedLayout() {
  const { user } = Route.useRouteContext();
  return (
    <SidebarProvider>
      <AppSidebar userName={user.name || user.email || ""} />
      <SidebarInset>
        {/* 移动端:汉堡唤出 off-canvas 侧栏(桌面侧栏常驻,故仅窄屏显示)。 */}
        <div className="flex items-center p-3 md:hidden">
          <SidebarTrigger />
        </div>
        <div className="container mx-auto px-4 pb-10 md:px-8 md:py-8">
          <Outlet />
        </div>
      </SidebarInset>
    </SidebarProvider>
  );
}
