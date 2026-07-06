import { createFileRoute, Outlet, redirect } from "@tanstack/react-router";
import { AppShell } from "../components/app-shell";
import { CurrencyProvider } from "../lib/hooks/use-prefer-currency";
import { getDisplayCurrency } from "../lib/server/currency";
import { fetchCurrentUser } from "../lib/server/session";

// 受保护布局:无 session 则重定向到 /login(仅 UX;数据安全靠各 authedServerFn)。
// loader 定展示币种 + 汇率(cookie + FX cache-only)→ CurrencyProvider 下发给整个认证区。
export const Route = createFileRoute("/_authed")({
  beforeLoad: async () => {
    const current = await fetchCurrentUser();
    if (!current) throw redirect({ to: "/login" });
    return { user: current.user };
  },
  loader: () => getDisplayCurrency(),
  component: AuthedLayout,
});

function AuthedLayout() {
  const { user } = Route.useRouteContext();
  const preferCurrency = Route.useLoaderData();
  return (
    <CurrencyProvider value={preferCurrency}>
      <AppShell userName={user.name || user.email || ""}>
        <Outlet />
      </AppShell>
    </CurrencyProvider>
  );
}
