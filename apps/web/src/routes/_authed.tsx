import { useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute, Outlet, redirect, retainSearchParams } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { z } from "zod";
import { AppShell } from "@/components/app-shell";
import { LockScreen } from "@/components/lock-screen";
import { PortfolioSelector } from "@/components/portfolio-selector";
import { PortfolioProvider, usePortfolio } from "@/lib/hooks/use-portfolio";
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
  // 选中的 Portfolio 进 URL(ADR 0046):`?portfolio=<id>`,默认那个不写。声明在**这一层** ——
  // 作用域是全站的(总额 / 代币 / 曲线 / Insights,ADR 0033),三页共享同一个参数。
  //
  // `.catch(undefined)` 与 home / accounts 那两条同款:地址栏里敲坏一个参数(空串、重复参数)
  // 不该把页面打没,统一收成「没带这个参数」。认不出的 id 由 `pickSelectedPortfolio` 兜回默认。
  validateSearch: z.object({
    portfolio: z.string().min(1).optional().catch(undefined),
  }),
  // 跨页保留:链接与程序化导航都不必手动带这个参数,**没有地方可以忘**(这正是选查询参数而非
  // 路径参数的关键理由之一,见 ADR 0046)。它只在「新 search 里没有这个键」时补旧值,并且尊重
  // 显式写的 `portfolio: undefined` —— 所以「切回默认 → 参数消失」与这条同时成立。
  search: { middlewares: [retainSearchParams(["portfolio"])] },
  beforeLoad: async () => {
    const current = await getSession();
    if (!current) throw redirect({ to: "/login" });
    return { user: current.user };
  },
  loader: async ({ context }) => {
    // **同步摘要要先知道是哪个 Portfolio**(ADR 0033),所以这两个不能并发:先拿到 Portfolio 列表
    // 才知道默认那个的 id。首屏按默认那个预取 —— 选中态初始就是它(见 use-portfolio)。
    const [, portfolios] = await Promise.all([
      context.queryClient.ensureQueryData(currencyPreferenceQuery()),
      context.queryClient.ensureQueryData(portfolioListQuery()),
    ]);
    await context.queryClient.ensureQueryData(syncStatusQuery(portfolios.defaultId));
  },
  component: AuthedLayout,
});

// 外壳那一层要的同步摘要**必须在 Provider 之内取**:它按选中的 Portfolio 而来,而选中态就住
// Provider 里。以前在 Provider 外面取(那时摘要是全局的,取哪儿都一样)—— 收口之后不行了,
// 在外面取到的永远是默认那个,切了组合外壳上的来源数不会动。
function ShellWithSync({ userName, children }: { userName: string; children: ReactNode }) {
  const { selectedId } = usePortfolio();
  const { data: syncStatus } = useSuspenseQuery(syncStatusQuery(selectedId));
  return (
    <AppShell userName={userName} syncStatus={syncStatus} selector={<PortfolioSelector />}>
      {children}
    </AppShell>
  );
}

function AuthedLayout() {
  const { user } = Route.useRouteContext();
  const { data: preferCurrency } = useSuspenseQuery(currencyPreferenceQuery());
  const { data: portfolios } = useSuspenseQuery(portfolioListQuery());
  return (
    <CurrencyProvider value={preferCurrency}>
      {/* Portfolio 选中态(ADR 0033):住布局层,三页共享;事实源是 URL 上的 `?portfolio=`(ADR 0046)。 */}
      <PortfolioProvider portfolios={portfolios.portfolios} defaultId={portfolios.defaultId}>
        {/* 闲置锁屏(ADR 0029)：父包裹整个认证区，锁定时卸载下方 App(DOM 不留内容)、只留锁屏。 */}
        <LockScreen>
          <ShellWithSync userName={user.name || user.email || ""}>
            <Outlet />
          </ShellWithSync>
        </LockScreen>
      </PortfolioProvider>
    </CurrencyProvider>
  );
}
