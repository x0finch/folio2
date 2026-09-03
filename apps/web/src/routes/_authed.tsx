import { EASE_OUT } from "@folio/ui/lib/ease";
import { useSuspenseQuery } from "@tanstack/react-query";
import {
  createFileRoute,
  isRedirect,
  Outlet,
  redirect,
  retainSearchParams,
  useRouterState,
} from "@tanstack/react-router";
import { motion, useReducedMotion } from "motion/react";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { useTranslations } from "use-intl";
import { z } from "zod";
import { AppShell, AppShellSkeleton } from "@/components/app-shell";
import { LockScreen } from "@/components/lock-screen";
import { PortfolioSelector } from "@/components/portfolio-selector";
import { PortfolioProvider, pickSelectedPortfolio, usePortfolio } from "@/lib/hooks/use-portfolio";
import { CurrencyProvider } from "@/lib/hooks/use-prefer-currency";
import { RETRY, withRetry } from "@/lib/queries/constants";
import { portfolioListQuery } from "@/lib/queries/portfolio";
import { currencyPreferenceQuery } from "@/lib/queries/preferences";
import { prefetchSyncStatusAtoms, useSyncStatus } from "@/lib/queries/sync";
import { getSession } from "@/lib/server/session";

// 受保护布局:无 session 则重定向到 /login(仅 UX;数据安全靠各 authedServerFn)。
// loader 定展示币种 + 汇率(cookie + FX cache-only),并**预取**全局同步状态
// → CurrencyProvider + AppShell 下发给整个认证区。
//
// 同步状态不再由 loader 返回,而是 `ensureQueryData` 预取 + 组件 `useSuspenseQuery` 读(ADR 0038)。
// loader 里 await 的东西没有 key 可指,只能整页刷;进了缓存才刷得动一个前缀。首屏不变:
// 预取没 resolve 时路由 pending 照常生效,SSR 把缓存 dehydrate 下去,客户端直接 hydrate。
export const Route = createFileRoute("/_authed")({
  // **登录后的整棵树不做服务端渲染**(ADR 0049)。
  //
  // 为什么:生产跑 Cloudflare 免费档,一次请求只给 10 毫秒 CPU;而服务端渲这些页面要串行跑
  // 26 个数据查询,每个都背着约百毫秒的框架杂务,合计约 3 秒 —— 10 毫秒处被掐,整站白屏。
  // 业务计算本身不到 10ms(实测:总览 1.1ms、24h 盈亏 6.1ms),被掐死的是「在请求里跑它们」
  // 这件事本身。所以 loader 与组件全部搬进浏览器,服务器只出下面那张零数据的骨架壳。
  //
  // **必须是 `false`,不是 `'data-only'`**:后者只是不渲染 HTML,loader 照样在服务端跑,
  // 那 3 秒 CPU 一毫秒都没省 —— 它解决的是别的问题。
  //
  // 这个设置**整树继承**(router-core 的 `parentMatch?.ssr === false` 分支),所以四个子页面
  // 不必各写一遍;跟着一起下去的还有 `beforeLoad`,也就是下面那次真鉴权只在浏览器里跑了。
  // 「没登录 → 307 /login」因此搬去了根路由,判据换成 cookie 存在性,见 routes/-root/authed-guard。
  ssr: false,
  // 服务端渲染的**唯一**东西:零数据骨架壳。`ssr: false` 的匹配在服务端会被渲成
  // `<ClientOnly fallback={pendingComponent}>`,所以这里填什么,服务器就发什么。
  // 它同时是客户端接手后 loader 未落地那一段的 Suspense fallback —— 首帧到数据浮现之间
  // 观感连续,不闪两种东西。
  pendingComponent: PendingShell,
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
  beforeLoad: async ({ abortController }) => {
    // 这次调用不走查询缓存,所以 QueryClient 上那份重试默认值管不到它 —— 单独包一层同款退避,
    // 且**不放弃**(理由见 constants 的 withRetry)。signal 一定要接:导航取消 / 预取被丢弃时
    // 路由会 abort 它,不接的话每次取消都留一条循环在后台打服务器。
    const current = await withRetry(getSession, isRedirect, RETRY.forever, abortController.signal);
    if (!current) throw redirect({ to: "/login" });
    return { user: current.user };
  },
  // **这里故意不声明 `loaderDeps`**(与 home / insights 相反),尽管 loader 读了地址里的组合参数:
  // 声明了的话 match id 会跟着参数变 → 每次切组合都是一个**新 match** → `beforeLoad` 跟着重跑,
  // 也就是每切一下组合多一次 `getSession()` 往返。而这个 loader 读那个参数只为了「首次进入时预取对的
  // 那份摘要」——切组合那条路径上,页头的摘要由 `ShellWithSync` 自己的 `useSuspenseQuery` 取,
  // 不需要 loader 再跑一次。
  loader: async ({ context, location, cause }) => {
    // **同步摘要要先知道是哪个 Portfolio**(ADR 0033),所以这两个不能并发:先拿到 Portfolio 列表
    // 才认得出地址里那个 id(以及默认那个)。
    const [, portfolios] = await Promise.all([
      context.queryClient.ensureQueryData(currencyPreferenceQuery()),
      context.queryClient.ensureQueryData(portfolioListQuery()),
    ]);
    // 按**地址里那个**组合预取(ADR 0046)。以前写死 `defaultId` 恰好是对的 —— 那时选中态总是从默认
    // 开始;URL 能说别的之后,不改这里会静默慢一拍:硬加载一个非默认地址先取默认那份,组件再各自
    // 重拉一遍。读的是 `location.search`(原始解析结果,可能是空串/数组),兜底交给这个纯函数。
    //
    // 那份 search 在 loader 里**没有类型**(它是原始解析结果,不是某条路由校验过的那份),所以就地
    // 断言成「可能有这个键」,值合不合法交给纯函数判 —— 它收 `unknown` 正是为了这个调用点。
    const requested = (location.search as { portfolio?: unknown }).portfolio;
    const selectedId = pickSelectedPortfolio(
      requested,
      portfolios.portfolios,
      portfolios.defaultId,
    );
    const summaryAtoms = prefetchSyncStatusAtoms(context.queryClient, selectedId);
    // 只有**首次进入**才等。这个 `await` 是替页头那块同步摘要挡首屏挂起的(它没有自己的 suspense
    // 边界),冷加载时不等它会退成整页挂起。站内往返 / invalidate 触发的重跑(`cause === "stay"`)
    // 不必等:那时旧界面还在,让它自己挂起就好。
    if (cause === "enter") await summaryAtoms;
  },
  component: AuthedLayout,
  // 最后一道网:退避重试都用尽了(约半分钟),仍旧失败时接住它 —— 否则落到框架自带的那张
  // 白底「Something went wrong!」上,没有外壳、没有导航、也不会再试,只能自己刷新。
  // 这里继续每隔一段重跑整条路由:服务器缓过来的下一轮就自己长回来了。
  errorComponent: StalledShell,
});

/** 等了这么久还没数据,就把「连不上」这句话摆出来 —— 短于它的等待是正常首屏,不必解释。 */
const SAY_STALLED_AFTER = 12_000;

// 等待态的壳。**服务端渲染的就是它**(`ssr: false` 下 pendingComponent 即服务器发的 HTML),
// 那一趟没有计时器、也就没有那句话:首帧永远是干净的骨架。话只在浏览器里等超时后才出现。
function PendingShell() {
  const t = useTranslations("Shell");
  const [stalled, setStalled] = useState(false);
  useEffect(() => {
    const timer = setTimeout(() => setStalled(true), SAY_STALLED_AFTER);
    return () => clearTimeout(timer);
  }, []);
  return <AppShellSkeleton note={stalled ? t("stalled") : null} />;
}

// 最后一道网,接的是**渲染异常**:复位它有用,因为下一次渲染是全新的一次尝试。
// 拉取失败落到这里则是另一回事 —— 那时 match 是 error 态,`reset` 清不掉它(见 constants 的
// withRetry 注释),所以拉取失败那条路是靠「外壳数据与鉴权一直重试、根本不进 error 态」堵住的,
// 不是靠这里。
function StalledShell({ reset }: { reset?: () => void }) {
  const t = useTranslations("Shell");
  useEffect(() => {
    if (!reset) return;
    const timer = setInterval(reset, RETRY.selfHeal);
    return () => clearInterval(timer);
  }, [reset]);
  return <AppShellSkeleton note={t("stalled")} />;
}

// 外壳那一层要的同步摘要**必须在 Provider 之内取**:它按选中的 Portfolio 而来,而选中态就住
// Provider 里。以前在 Provider 外面取(那时摘要是全局的,取哪儿都一样)—— 收口之后不行了,
// 在外面取到的永远是默认那个,切了组合外壳上的来源数不会动。
function ShellWithSync({ userName, children }: { userName: string; children: ReactNode }) {
  const { selectedId } = usePortfolio();
  const syncStatus = useSyncStatus(selectedId);
  return (
    <AppShell userName={userName} syncStatus={syncStatus} selector={<PortfolioSelector />}>
      {children}
    </AppShell>
  );
}

// 四个 tab 切换的转场:内容区**轻淡入 + 微上抬**,外壳(顶栏/Dock)不动。按**顶层 tab** 做 key —
// 只有换 tab 才重放;tab 内深层导航、`?portfolio=` 变化不动(pathname 首段不变)。
//
// **enter-only(不做退场)**:TanStack 的 `<Outlet/>` 永远渲染当前路由,想做真交叉溶解得冻结旧 match、
// 得不偿失;新页淡入上抬已够顺,且不和「_authed 整树 ssr:false + 每页 Suspense」打架(无双挂载)。
// 动画结束**清掉 inline transform** — 否则 `translateY(0)` 也会成为 fixed 后代的包含块,困住页面里的
// fixed 弹层(MorphingModal `fixed inset-0` 等)。`prefers-reduced-motion` 直接原样渲染、不动。
function PageTransition({ children }: { children: ReactNode }) {
  const tab = useRouterState({ select: (s) => s.location.pathname.split("/")[1] ?? "" });
  const reduce = useReducedMotion();
  const ref = useRef<HTMLDivElement>(null);
  if (reduce) return <>{children}</>;
  return (
    <motion.div
      key={tab}
      ref={ref}
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.22, ease: EASE_OUT }}
      onAnimationComplete={() => {
        if (ref.current) ref.current.style.transform = "none";
      }}
    >
      {children}
    </motion.div>
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
            <PageTransition>
              <Outlet />
            </PageTransition>
          </ShellWithSync>
        </LockScreen>
      </PortfolioProvider>
    </CurrencyProvider>
  );
}
