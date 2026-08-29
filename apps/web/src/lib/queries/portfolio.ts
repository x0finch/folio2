import { queryOptions } from "@tanstack/react-query";
import {
  getHomeTabStrip,
  getPortfolioGain24h,
  getPortfolioHistory,
  getPortfolioOverview,
} from "@/lib/server/portfolio";
import { listPortfolios } from "@/lib/server/portfolios";
import { awaitFirstCompute, pendingPollDelay, RETRY, STALE_TIME, shouldRetry } from "./constants";
import { type PinScopeKey, portfolioKeys } from "./keys";

// 组合域的读取入口 —— 与 `lib/server/portfolio`(读模型)+ `lib/server/portfolios`(实体)的读取型 server fn 对应。
//
// **`staleTime` 在 #412 打开**:这个域的写路径已经全部改成定向刷新,开缓存不会让任何一条
// 「改了东西画面要跟着动」的路径失灵。收益是页间来回切与 hover 预热不再重复打服务器 ——
// 首页 ⇄ 账户页 ⇄ 洞察页共用同一份总览,以前每次导航都真拉一遍。

/** 一份组合总览的形状(按代币聚合的持仓 + 分段 + 小计)。消费方拆解 sections 时用得上。 */
export type PortfolioOverview = Awaited<ReturnType<typeof getPortfolioOverview>>;

export const portfolioListQuery = () =>
  queryOptions({
    queryKey: portfolioKeys.list(),
    queryFn: () => listPortfolios(),
    staleTime: STALE_TIME.live,
    // 外壳没有它就画不出来(组合徽章 / 选中态),所以**不放弃**:一直停在骨架上重试,
    // 好过让这条 match 变成 error —— error 态自己好不了(见 constants 的 withRetry)。
    retry: (failureCount, error) => shouldRetry(failureCount, error, RETRY.forever),
  });

/** 首页 tab 条:有没有永续 / DeFi + 自定义 Tab 的已解析标签。 */
export type HomeTabStrip = Awaited<ReturnType<typeof getHomeTabStrip>>;

export const homeTabStripQuery = (portfolioId: string) =>
  queryOptions({
    queryKey: portfolioKeys.tabStrip(portfolioId),
    queryFn: ({ signal }) =>
      awaitFirstCompute(
        () => getHomeTabStrip({ data: { portfolioId } }),
        // 「零账户」就是这条数据的空态 —— 而它同时是那句「还没有账户」的判据。
        (strip) => !strip.hasAccounts,
        signal,
      ),
    staleTime: STALE_TIME.live,
    refetchInterval: pendingPollDelay,
  });

// 一份总览 = 一个组合口径(+ 可选的自定义 Tab 收窄)。默认视图与非默认视图、Tab 视图走的是
// **同一个工厂**,只是参数不同 —— 这正是「一句前缀刷新盖住三种视图」的前提。
export const portfolioOverviewQuery = (portfolioId: string, pin?: PinScopeKey) =>
  queryOptions({
    queryKey: portfolioKeys.overview(portfolioId, pin),
    queryFn: ({ signal }) =>
      awaitFirstCompute(
        () => getPortfolioOverview({ data: { portfolioId, pin } }),
        // 「一个账户都没有」= 屏幕上没有任何东西可画,总额那个 0 也就没有依据。
        (view) => view.accountTotals.length === 0,
        signal,
      ),
    staleTime: STALE_TIME.live,
    // 见 `portfolioGain24hQuery` 那段:`pending` 期间短轮询,算好了整条就停。
    refetchInterval: pendingPollDelay,
  });

export const portfolioHistoryQuery = (portfolioId: string) =>
  queryOptions({
    queryKey: portfolioKeys.history(portfolioId),
    queryFn: () => getPortfolioHistory({ data: { portfolioId } }),
    staleTime: STALE_TIME.live,
  });

/**
 * 24h 盈亏:组合级 + 按持仓 / DeFi 协议分组。自定义 Tab 把 pin 传进来。
 *
 * **`pending` → 短轮询**(ADR 0049):这份数是同步收官时预计算的,读接口只做「读 + 传」。
 * 没算过 / 刚失效的时候它如实说一句「还在算」,服务端同时安排一趟后台补算 —— 不盯着的话,
 * 补算几百毫秒就落好了,而这份空响应会按 `staleTime` 在前端揣满 30 秒。
 * 手法与同步轮进度那条一样(ADR 0048):**只在有东西正在变的时候才开**。轮询有退避、会放弃
 * (`pendingPollDelay`)—— 理由写在那儿。
 *
 * **`pending` 期间界面不做任何视觉区分,这是想过之后的决定。** 那一刻屏幕上那个数是上一次
 * 权威计算的结果(通常几分钟前),而正确值一秒内就会顶上来。给它加个「重算中」的样子意味着:
 * 每小时的 cron、每一次同步、每一笔手记改动、每一次刷价,那个数都要闪一下 —— 一个每小时
 * 「不确定」好几次的界面,比一个偶尔慢一分钟的界面更难信。ADR 0049 收下的代价本来就是
 * 「算的时刻 ≠ 看的时刻」,`pending` 是给**取数**用的信号,不是给眼睛的。
 * (真正算不出来的时候界面照旧画 `—`,那条路一个字没动。)
 */
export const portfolioGain24hQuery = (portfolioId: string, pin?: PinScopeKey) =>
  queryOptions({
    queryKey: portfolioKeys.gain24h(portfolioId, pin),
    queryFn: () => getPortfolioGain24h({ data: { portfolioId, pin } }),
    staleTime: STALE_TIME.live,
    // 隔 1s 再问,之后翻倍,八次收手 —— **次数按「这一轮 pending」数**,见 `pendingPollDelay`
    // (拿这条查询的一辈子成功次数去数,页面开久了轮询会自己永久关掉)。算好了整条就停。
    refetchInterval: pendingPollDelay,
  });
