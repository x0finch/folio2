import { getRouteApi, useNavigate } from "@tanstack/react-router";
import { createContext, type ReactNode, useContext } from "react";

// 当前选中的 Portfolio(ADR 0033)。主页 / 账户页 / Insights 共享同一个选中态 —— 住 _authed 布局层,
// 选谁三页都 scope 到谁。
//
// **事实源是 URL**(ADR 0046):`?portfolio=<id>`,默认那个不写。于是硬刷新留在原组合、链接分享/收藏
// 落在同一个组合、后退键撤销一次切换。这里**不再持有任何状态** —— 「选中谁」只有一个答案,
// 界面与后退键不会各说一套。
//
// 下面两个纯函数(读回哪个组合 / 切换后的新查询串)**就住这儿**,不另开文件:它们讲的就是这个概念,
// 而「共用」不是新建文件的理由(CODING.md)。`_authed` 的 loader 也用它们 —— 探过针:这个文件虽然
// 拉进 `@tanstack/react-router`,在单测的 logic 环境里 import 得动,所以没有非拆不可的理由。

const authed = getRouteApi("/_authed");

export interface PortfolioSummary {
  id: string;
  name: string;
  isDefault: boolean;
}

// 地址里写着谁 → 实际选中谁。
//
// `requested` 收 `unknown` 是**故意的**:两个调用点拿到的东西不一样干净 —— 这里读的是 route 校验过的
// search(`string | undefined`),而 `_authed` 的 loader 读的是 `location.search`(原始解析结果:
// `?portfolio=` 是空串,`?portfolio=a&portfolio=b` 是数组,`?portfolio=123` 是数字)。
//
// 判据只有一条:**它是不是名单里的一个 id**。不是的一律当没带 —— 不抛错、不重定向。于是「组合被删了」
// 「手写乱码」「拼了别人的 id」三种情况完全同一个待遇,越权探测拿不到任何可区分的回应差异。
export function pickSelectedPortfolio(
  requested: unknown,
  portfolios: readonly { id: string }[],
  defaultId: string,
): string {
  if (typeof requested !== "string") return defaultId;
  return portfolios.some((p) => p.id === requested) ? requested : defaultId;
}

// 切到某个组合之后的**整份**查询串。
//
// 是「一份全新的」而不是「在原来那份上改一个键」(ADR 0046):`tab` / `token` / `account` / `focus`
// 装的都是旧组合里的具体东西(pin id、token id、账户 id),带进新组合是无意义或静默空白;`dim`
// 与组合无关、本可以留 —— 但**不留的规则更短**:「切组合就是从头开始」不需要维护一张「哪些该留」的
// 清单,而那种清单每加一个新参数都要有人回来判一次。
//
// 默认组合写成 `undefined`(键在、值没有)→ 地址里不出现这个参数。这一步只能在这儿做:官方的
// `stripSearchParams` 只收静态默认值,而「哪个组合是默认」是每用户的运行时数据。
//
// **键必须在**:`retainSearchParams` 靠「新 search 里有没有这个键」决定要不要把旧值补回来 ——
// 键都不写的话,切回默认的那一下会被它原样填回去,参数永远消不掉。
export function portfolioSwitchSearch(
  id: string,
  defaultId: string,
): { portfolio: string | undefined } {
  return { portfolio: id === defaultId ? undefined : id };
}

interface PortfolioContextValue {
  portfolios: PortfolioSummary[];
  defaultId: string;
  selectedId: string;
  select: (id: string) => void;
}

const PortfolioContext = createContext<PortfolioContextValue | null>(null);

export function PortfolioProvider({
  portfolios,
  defaultId,
  children,
}: {
  portfolios: PortfolioSummary[];
  defaultId: string;
  children: ReactNode;
}) {
  const { portfolio } = authed.useSearch();
  const navigate = useNavigate();
  // 「选中的组合已不存在 → 退回默认」这条守卫不再是一个 state 修正,而是一次读时兜底。
  const selectedId = pickSelectedPortfolio(portfolio, portfolios, defaultId);
  const select = (id: string) => {
    const next = portfolioSwitchSearch(id, defaultId);
    // 拿新参数与**地址里当前那个原值**比,不与 selectedId 比:后者已经兜过底,那样比的话
    // 「地址里是个认不出的 id、点一下默认组合」会被当成没变,那个死值就永远清不掉了。
    if (next.portfolio === portfolio) return;
    // 切组合 = 一份全新的查询串 + 进后退栈(`push`,默认)+ 回顶部(`resetScroll`,默认)。
    // 三条都在 ADR 0046 里:换的是「看的对象」,不是「看法」。
    //
    // 不需要 `startTransition`:router 的导航本来就跑在 React transition 里(见
    // `-home/tab/selection.ts` 那段),旧数字会一直留到新数据就绪,画面不闪回骨架。
    //
    // `to: "."` = 留在当前页面(在账户页切组合不该把人送回首页)。省略 `to` 也是同一个落点,但那时
    // 编译期不知道目标路由,`search` 的类型收成 `never`;`from: "/_authed"` 更不行 —— 这是个无路径
    // 布局路由,它没有自己的 fullPath。`search` 写成函数只是为了配合 `to: "."` 的类型,返回值原样
    // 就是新的整份 search,与对象形式等价。
    navigate({ to: ".", search: () => next });
  };
  return (
    <PortfolioContext.Provider value={{ portfolios, defaultId, selectedId, select }}>
      {children}
    </PortfolioContext.Provider>
  );
}

export function usePortfolio(): PortfolioContextValue {
  const ctx = useContext(PortfolioContext);
  if (!ctx) throw new Error("usePortfolio must be used within PortfolioProvider");
  return ctx;
}
