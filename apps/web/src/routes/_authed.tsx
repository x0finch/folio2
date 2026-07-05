import { createFileRoute, Outlet, redirect } from "@tanstack/react-router";
import { AppShell } from "../components/app-shell";
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
    <AppShell userName={user.name || user.email || ""}>
      <Outlet />
    </AppShell>
  );
}
