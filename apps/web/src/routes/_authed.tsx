import { createFileRoute, Outlet, redirect } from "@tanstack/react-router";
import { AppShell } from "../components/app-shell";
import { LockScreen } from "../components/lock-screen";
import { PortfolioSelector } from "../components/portfolio-selector";
import { PortfolioProvider } from "../lib/hooks/use-portfolio";
import { CurrencyProvider } from "../lib/hooks/use-prefer-currency";
import { listPortfolios } from "../lib/server/portfolio";
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
    const [preferCurrency, syncStatus, portfolios] = await Promise.all([
      getCurrencyPreference(),
      getSyncStatus(),
      listPortfolios(),
    ]);
    return { preferCurrency, syncStatus, portfolios };
  },
  component: AuthedLayout,
});

function AuthedLayout() {
  const { user } = Route.useRouteContext();
  const { preferCurrency, syncStatus, portfolios } = Route.useLoaderData();
  return (
    <CurrencyProvider value={preferCurrency}>
      {/* Portfolio 选中态(ADR 0033):住布局层,三页共享;不持久化(硬刷新回默认由布局重挂实现)。 */}
      <PortfolioProvider portfolios={portfolios.portfolios} defaultId={portfolios.defaultId}>
        {/* 闲置锁屏(ADR 0029)：父包裹整个认证区，锁定时卸载下方 App(DOM 不留内容)、只留锁屏。 */}
        <LockScreen userEmail={user.email}>
          <AppShell
            userName={user.name || user.email || ""}
            syncStatus={syncStatus}
            selector={<PortfolioSelector />}
          >
            <Outlet />
          </AppShell>
        </LockScreen>
      </PortfolioProvider>
    </CurrencyProvider>
  );
}
