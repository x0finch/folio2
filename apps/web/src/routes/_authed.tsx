import { createFileRoute, Outlet, redirect } from "@tanstack/react-router";
import { AppShell } from "../components/app-shell";
import { CurrencyProvider } from "../lib/hooks/use-prefer-currency";
import { getCurrencyPreference } from "../lib/server/preferences";
import { getSession } from "../lib/server/session";
import { getSyncStatus } from "../lib/server/sync";

// 受保护布局:无 session 则重定向到 /login(仅 UX;数据安全靠各 authedServerFn)。
// loader 定展示币种 + 汇率(cookie + FX cache-only)+ 全局同步状态(PageHeader 同步面板)
// → CurrencyProvider + AppShell 下发给整个认证区。
export const Route = createFileRoute("/_authed")({
  beforeLoad: async () => {
    const current = await getSession();
    if (!current) throw redirect({ to: "/login" });
    return { user: current.user };
  },
  loader: async () => {
    const [preferCurrency, syncStatus] = await Promise.all([
      getCurrencyPreference(),
      getSyncStatus(),
    ]);
    return { preferCurrency, syncStatus };
  },
  component: AuthedLayout,
});

function AuthedLayout() {
  const { user } = Route.useRouteContext();
  const { preferCurrency, syncStatus } = Route.useLoaderData();
  return (
    <CurrencyProvider value={preferCurrency}>
      <AppShell userName={user.name || user.email || ""} syncStatus={syncStatus}>
        <Outlet />
      </AppShell>
    </CurrencyProvider>
  );
}
