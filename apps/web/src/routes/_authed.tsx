import { useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute, Outlet, redirect } from "@tanstack/react-router";
import { AppShell } from "@/components/app-shell";
import { LockScreen } from "@/components/lock-screen";
import { PortfolioSelector } from "@/components/portfolio-selector";
import { PortfolioProvider } from "@/lib/hooks/use-portfolio";
import { CurrencyProvider } from "@/lib/hooks/use-prefer-currency";
import { portfolioListQuery } from "@/lib/queries/portfolio";
import { currencyPreferenceQuery } from "@/lib/queries/preferences";
import { syncStatusQuery } from "@/lib/queries/sync";
import { getSession } from "@/lib/server/session";

// 受保护布局:无 session 则重定向到 /login(仅 UX;数据安全靠各 authedServerFn)。
// loader 定展示币种 + 汇率(cookie + FX cache-only),并**预取**全局同步状态
// → CurrencyProvider + AppShell 下发给整个认证区。
//
// 同步状态不再由 loader 返回,而是 `ensureQueryData` 预取 + 组件 `useSuspenseQuery` 读(ADR 0038)。
// loader 里 await 的东西没有 key 可指,只能整页刷;进了缓存才刷得动一个前缀。首屏不变:
// 预取没 resolve 时路由 pending 照常生效,SSR 把缓存 dehydrate 下去,客户端直接 hydrate。
export const Route = createFileRoute("/_authed")({
  beforeLoad: async () => {
    const current = await getSession();
    if (!current) throw redirect({ to: "/login" });
    return { user: current.user };
  },
  loader: async ({ context }) => {
    await Promise.all([
      context.queryClient.ensureQueryData(currencyPreferenceQuery()),
      context.queryClient.ensureQueryData(syncStatusQuery()),
      context.queryClient.ensureQueryData(portfolioListQuery()),
    ]);
  },
  component: AuthedLayout,
});

function AuthedLayout() {
  const { user } = Route.useRouteContext();
  const { data: preferCurrency } = useSuspenseQuery(currencyPreferenceQuery());
  const { data: syncStatus } = useSuspenseQuery(syncStatusQuery());
  const { data: portfolios } = useSuspenseQuery(portfolioListQuery());
  return (
    <CurrencyProvider value={preferCurrency}>
      {/* Portfolio 选中态(ADR 0033):住布局层,三页共享;不持久化(硬刷新回默认由布局重挂实现)。 */}
      <PortfolioProvider portfolios={portfolios.portfolios} defaultId={portfolios.defaultId}>
        {/* 闲置锁屏(ADR 0029)：父包裹整个认证区，锁定时卸载下方 App(DOM 不留内容)、只留锁屏。 */}
        <LockScreen>
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
