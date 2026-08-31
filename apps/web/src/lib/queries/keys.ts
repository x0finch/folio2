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
  /** 整个同步域的前缀 —— 刷新映射表用它(目前只有 round 查询)。 */
  all: ["sync"] as const,
  /**
   * 这个组合最近一轮同步(ADR 0048)。**在 `all` 前缀之下**,所以「一轮跑完」那条定向刷新
   * 照样盖得住它。按组合一份:切组合看的就是另一轮。
   *
   * 页头同步摘要(FOL-58)不再单独占 key —— 由 accounts + snapshots 在浏览器派生。
   */
  round: (portfolioId: string) => [...syncKeys.all, "round", portfolioId] as const,
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
  /**
   * tab 域前缀 —— 刷新映射表用它;`tabPins` 查询挂在这层下面。
   * 改 pin 不必重拉快照原料(overview 走缓存)。
   */
  tabs: () => [...portfolioKeys.all, "tabs"] as const,
  /** 首页 tab 条 pin 原料 —— 与 overview 分 key;改 pin 只刷这层。 */
  tabPins: (portfolioId: string) => [...portfolioKeys.tabs(), "pins", portfolioId] as const,
  /**
   * QueryBoundary resetKey:总览由原子 query 在浏览器合并,pin 进 key 区分不同收窄。
   * **不是 react-query 缓存键** —— 各原子资源有自己的 key。
   */
  overviewCompose: (portfolioId: string, pin?: PinScopeKey) =>
    [...portfolioKeys.all, "overview-compose", portfolioId, pin ?? null] as const,
  /** 组合走势(**不受 pin 影响** —— 自定义 Tab 只收窄列表,不进曲线)。 */
  history: (portfolioId: string, range: string) =>
    [...portfolioKeys.all, "history", portfolioId, range] as const,
  /**
   * 快照域前缀 —— 刷新映射表用它;各 `at`/`after` 的快照查询都挂在这层下面。
   */
  snapshotsPrefix: () => [...portfolioKeys.all, "snapshots"] as const,
  /**
   * 组合内各账户在 `[after, at]` 窗口内最新快照(FOL-54)。key 用 hour-floor 锚;
   * 请求体的 `at` 是真实查库上界(当下快照 = 墙钟)。
   */
  snapshots: (portfolioId: string, at: number, after?: number) =>
    [...portfolioKeys.all, "snapshots", portfolioId, at, after ?? null] as const,
  /** 手记法币身份 ref(tokenId → fiat 命名者),按组合一份。 */
  fiatRefs: (portfolioId: string) => [...portfolioKeys.all, "fiat-refs", portfolioId] as const,
  /** fiatRefs 域前缀 —— 手记代币变更后刷新映射表用它。 */
  fiatRefsPrefix: () => [...portfolioKeys.all, "fiat-refs"] as const,
  /** 链平台展示元数据;键集由客户端从快照原料算好再传入。 */
  platformMeta: (chainIds: readonly string[]) =>
    [...portfolioKeys.all, "platform-meta", ...chainIds] as const,
  // 24h 盈亏无独立 key(FOL-51):它随总览原料(`overview`)一起回,浏览器两端相减算出来。
};

export const accountKeys = {
  /** 整个账户域的前缀。 */
  all: ["accounts"] as const,
  /**
   * 当前组合的账户(含它的归档成员)+ 凭据投影。
   *
   * **portfolioId 进 key**(ADR 0047):这三条都由服务端按组合筛过了,不进 key 就会两个组合共用
   * 一份缓存 —— 切过去看到的是上一个组合的账户。
   */
  list: (portfolioId: string) => [...accountKeys.all, "list", portfolioId] as const,
  /**
   * 单账户价值历史。**key 里是窗口档位(`"30d"`)而不是算出来的起点时间戳** ——
   * 起点由 `Date.now()` 现算,每次渲染都是新数,进了 key 就等于每帧换一个缓存条目、永远拉不停。
   */
  history: (accountId: string, range: string) =>
    [...accountKeys.all, "history", accountId, range] as const,
  /** 单个持仓的价值历史(跨账户聚合的那一行)。同上,key 里是窗口档位。 */
  holdingHistory: (holdingKey: string, range: string) =>
    [...accountKeys.all, "token-value-history", holdingKey, range] as const,
  /** 手记账户明细(代币 + 活动账本)。 */
  manualDetail: (accountId: string) => [...accountKeys.all, "manual-detail", accountId] as const,
};

export const tagKeys = {
  /** 整个标签域的前缀。 */
  all: ["tags"] as const,
  /** 标签定义(per-Portfolio —— 服务端按组合筛,所以组合进 key)。 */
  list: (portfolioId: string) => [...tagKeys.all, "list", portfolioId] as const,
  /** 当前组合的账户 → 标签关联。展示富化仍在客户端按 accountId 组装。 */
  accountLinks: (portfolioId: string) => [...tagKeys.all, "account-links", portfolioId] as const,
};

export const settingsKeys = {
  /** 整个设置域的前缀。 */
  all: ["settings"] as const,
  /** 全局 provider key 的配置状态(哪些环境变量给了)。 */
  providerKeys: () => [...settingsKeys.all, "provider-keys"] as const,
  /** 估值口径(self-first / source-first)。 */
  valuation: () => [...settingsKeys.all, "valuation"] as const,
  /** 数据统计(账户 / 快照 / 代币行数)。 */
  dataStats: () => [...settingsKeys.all, "data-stats"] as const,
};

export const preferenceKeys = {
  /** 整个偏好域的前缀(展示币种、界面语言)。 */
  all: ["preferences"] as const,
  /** 展示币种 + 当前汇率。 */
  currency: () => [...preferenceKeys.all, "currency"] as const,
  /** 界面语言。 */
  locale: () => [...preferenceKeys.all, "locale"] as const,
};

export const connectorKeys = {
  /** 整个连接器域的前缀。**部署内静态** —— 没有任何写操作会碰它,所以刷新映射表里也没有它。 */
  all: ["connectors"] as const,
  /** connectorId → { label, logo } 的展示目录。 */
  catalogue: () => [...connectorKeys.all, "catalogue"] as const,
  /** 各 connector 的凭据字段规格(加账户表单按它渲染)。 */
  credentialSpecs: () => [...connectorKeys.all, "credential-specs"] as const,
};

export const tokenKeys = {
  /** 整个代币域的前缀。 */
  all: ["tokens"] as const,
  /** 代币目录(选币下拉的本地筛底料)。 */
  catalogue: () => [...tokenKeys.all, "catalogue"] as const,
  /** 法币选项(名字按请求 locale 本地化 → 切语言要刷)。 */
  fiatOptions: () => [...tokenKeys.all, "fiat-options"] as const,
  /** 上游代币搜索(本地目录凑不够时才问)。 */
  search: (query: string) => [...tokenKeys.all, "search", query] as const,
  /** 用户全部已知代币的展示富化(name/price/logo/change24h,FOL-54)。 */
  enrichment: () => [...tokenKeys.all, "enrichment"] as const,
};
