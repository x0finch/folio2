// 全部 queryKey 的工厂,按域分组。
//
// **分层,不平铺**(ADR 0038):`["sync","status"]` 而不是 `"sync-status"`。前缀即刷新粒度 ——
// 刷新映射表指的是域前缀(`sync.all`),这个域将来再加查询会自动被盖住,不用回头补一条
// 「还要刷哪个 key」。平铺键漏一个就是一个不刷新的 bug,而这类 bug 没有报错。
//
// **key 与 queryOptions 分家,是有原因的,别合回去。** queryOptions 要引 `lib/server/<域>.ts`
// 的 server fn,那条链上有 server-only 模块(`cloudflare:workers` 等),在 node 测试环境里
// import 不动。key 留在这个纯模块里,刷新映射表(refresh.ts)才只依赖它 —— 于是「映射表指的
// 前缀,是否真能匹配上各查询实际用的 key」这件事可以被单测钉住,而那正是整套定向刷新最容易
// 出错、又最不会报错的地方。
export const syncKeys = {
  /** 整个同步域的前缀 —— 刷新映射表用它。 */
  all: ["sync"] as const,
  /** 全局同步状态摘要(页头同步面板 + 「立即同步」的账户集)。 */
  status: () => [...syncKeys.all, "status"] as const,
};

// 自定义 Tab 的目标(ADR 0034)。进 key 是因为**同一个总览查询按 pin 收窄之后是另一份数据** ——
// 不进 key 就会两个 tab 共用一份缓存,切过去看到的是上一个 tab 的内容。
export interface PinScopeKey {
  kind: "connector" | "tag" | "account";
  connectorId?: string;
  tagId?: string;
  accountId?: string;
}

export const portfolioKeys = {
  /** 整个组合域的前缀。 */
  all: ["portfolio"] as const,
  /** 组合清单 + 默认组合 id。 */
  list: () => [...portfolioKeys.all, "list"] as const,
  /** 账户 → 所属组合。 */
  memberships: () => [...portfolioKeys.all, "memberships"] as const,
  /**
   * 自定义 Tab 清单。**单独一层,不跟 overview 混**:增删一个 Tab 不该让昂贵的总览重拉一遍,
   * 而映射表要指得动「只刷 Tab 清单」就得有这么一个前缀。
   */
  pins: () => [...portfolioKeys.all, "pins"] as const,
  /**
   * 组合总览。**portfolioId 必须是真实 id,不能用「缺省 = 默认」的 undefined** ——
   * loader 预取的那份与组件按 selectedId 读的那份,key 对不上就等于首屏白拉一遍。
   */
  overview: (portfolioId: string, pin?: PinScopeKey) =>
    [...portfolioKeys.all, "overview", portfolioId, pin ?? null] as const,
  /** 组合走势(**不受 pin 影响** —— 自定义 Tab 只收窄列表,不进曲线)。 */
  history: (portfolioId: string) => [...portfolioKeys.all, "history", portfolioId] as const,
};

export const accountKeys = {
  /** 整个账户域的前缀。 */
  all: ["accounts"] as const,
  /** 全部账户(含归档)+ 凭据投影。 */
  list: () => [...accountKeys.all, "list"] as const,
  /** 活跃账户的市值 / 上次同步 / 持仓明细。 */
  holdings: () => [...accountKeys.all, "holdings"] as const,
  /**
   * 单账户价值历史。**key 里是窗口档位(`"30d"`)而不是算出来的起点时间戳** ——
   * 起点由 `Date.now()` 现算,每次渲染都是新数,进了 key 就等于每帧换一个缓存条目、永远拉不停。
   */
  history: (accountId: string, range: string) =>
    [...accountKeys.all, "history", accountId, range] as const,
  /** 单个持仓的价值历史(跨账户聚合的那一行)。同上,key 里是窗口档位。 */
  holdingHistory: (holdingKey: string, range: string) =>
    [...accountKeys.all, "holding-history", holdingKey, range] as const,
  /** 手记账户明细(代币 + 活动账本)。 */
  manualDetail: (accountId: string) => [...accountKeys.all, "manual-detail", accountId] as const,
};

export const tagKeys = {
  /** 整个标签域的前缀。 */
  all: ["tags"] as const,
  /** 标签定义(per-Portfolio)。 */
  list: () => [...tagKeys.all, "list"] as const,
  /** 账户 → 标签的关联。整份返回,展示富化在客户端按 accountId 组装。 */
  accountLinks: () => [...tagKeys.all, "account-links"] as const,
};
