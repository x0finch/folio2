import { createFileRoute, notFound } from "@tanstack/react-router";
import { z } from "zod";
import { PageSwitcher } from "@/components/page-switcher";
import { pickSelectedPortfolio } from "@/lib/hooks/use-portfolio";
import { portfolioListQuery } from "@/lib/queries/portfolio";
import { prefetchSyncStatusAtoms } from "@/lib/queries/sync";
import { DEFAULT_PAGE, isPageSlug, type PageSlug } from "./-page-keys";
import { PAGES, prefetchPage } from "./-pages";

// 四个 page 合成一个路由(FOL-69 / FOL-81):可选路径参数 `page`(空段 = 总览,`accounts` /
// `insights` / `settings` 各对应一页)。网址照旧是 `/`、`/accounts`… —— 切 page 只换 `page` 参数,
// `PageSwitcher` 按它切可见的组件、去过的页 `<Activity>` 保活,不换路由、不卸载。
//
// `_authed` 那层(鉴权 / `ssr:false` / PendingShell / PortfolioProvider / 锁屏)一层不动(ADR 0049)。
export const Route = createFileRoute("/_authed/{-$page}")({
  // 路径段只认注册表里那三页。可选参数本身不限值,不拦的话 `/anything` 都会匹配到这条、外壳照渲、
  // 内容区空白 —— 在这里抛 notFound,认不出的段就是 404,和合并之前四条独立路由时一样。
  params: {
    parse: ({ page }): { page?: PageSlug } => {
      if (page !== undefined && !isPageSlug(page)) throw notFound();
      return { page };
    },
  },
  // 只剩 `focus` 一个自有 search:账户页的一次性「定位某账户」命令(同步面板跨页写它)。它落在这条
  // 合并路由上,因此**无论当前在哪个 page 都读得到**——这正是「一个路由」相对「四条独立路由」的关键:
  // 保活着的账户页即便不是当前可见页,读 search 也不会「读不到 match 而抛」(旧盖板方案栽的就是这个)。
  validateSearch: z.object({
    focus: z.string().min(1).optional().catch(undefined),
  }),
  // 预取跟着地址里的组合走(ADR 0046);切 page 时 `params.page` 变 → loader 重跑、预取新页那份。
  loaderDeps: ({ search }) => ({ portfolio: search.portfolio }),
  // 不阻塞式等页面数据:只等「是哪个组合」(预取 key 必须对上)与外壳那两条(见下),该页数据发出
  // 即返回,组件自己的 Suspense / QueryBoundary 兜加载态。切 page 因此即时,不等 loader。
  loader: async ({ context: { queryClient }, deps, params }) => {
    const { portfolios, defaultId } = await queryClient.ensureQueryData(portfolioListQuery());
    const selectedId = pickSelectedPortfolio(deps.portfolio, portfolios, defaultId);
    prefetchPage(params.page ?? DEFAULT_PAGE, queryClient, selectedId);
    // **唯一要等的:外壳那块同步摘要的两条原料**(账户列表 + 当下快照)。外壳(`ShellWithSync`)用
    // `useSuspenseQueries` 读它们,而它上面没有自己的 Suspense 边界 —— 切到一个**没看过的组合**时
    // 缓存里没有这两条,不等的话外壳整个挂起、被 Suspense 隐掉(display:none)换成 `_authed` 的骨架壳
    // 几十毫秒。页头组合药丸的换字动画正好在这段里起跑:元素隐着量不到尺寸,旧名字退不出去,新旧两个
    // 名字并排卡在药丸里直到下一次切换(生产构建实测)—— 用户看到的就是「药丸重叠」。
    // 等在这里,router 会把旧界面留到它们就绪再切;三页的预取里本来就有这两条(同 key),多等的
    // 只是它们本身。切 page(`params.page` 变)时它们早已在缓存里,这个 await 即回。
    await prefetchSyncStatusAtoms(queryClient, selectedId);
  },
  component: PageHost,
});

function PageHost() {
  const { page } = Route.useParams();
  return <PageSwitcher pages={PAGES} activeKey={page ?? DEFAULT_PAGE} />;
}
