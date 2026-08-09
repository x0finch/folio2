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
