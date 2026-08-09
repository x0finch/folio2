import type { QueryClient, QueryKey } from "@tanstack/react-query";
import { portfolioKeys, syncKeys } from "./keys";

// 刷新映射表:**一个写操作的语义 → 它改动了哪些 key 前缀**。
//
// 为什么是一张表而不是各调用点自己写 key 数组(ADR 0038):定向刷新的全部风险都在「漏刷」上,
// 而漏刷**不报错** —— 只表现为「改了东西画面不变」。散在二十几个调用点里的 key 数组没法审:
// 加一个新查询时,你得回去逐个想「谁应该刷到我」。收成一张表之后,这件事只在一个地方做,
// review 时一眼扫得完,而调用点只写自己知道的那件事:「我刚干了什么」。
//
// 语义命名用 `<域>.<动作>`。**跨域影响写成多条前缀**,别只写自己那个域 ——
// 比如账户增删同时改账户域与组合域(总额、走势),只刷账户域会让总览停在旧数字。
export const REFRESH_MAP = {
  /**
   * 一轮同步跑完。**失败也算**:同步本身可能仍在服务端跑(waitUntil),
   * 而且部分账户的快照可能已经落库了。
   *
   * 一轮同步改的是余额 → 组合域(总额、持仓、走势)跟着变,所以两个前缀都要刷。
   * **这一条顺带修掉一个既有 bug**:整页刷新只重跑 loader,而 loader 只预取「默认组合」那份 ——
   * 停在非默认组合、或停在自定义 Tab 上时,同步跑完画面根本不动。前缀刷新盖住整个域,三种视图一起更新。
   */
  "sync.round": [syncKeys.all, portfolioKeys.all],
} satisfies Record<string, readonly QueryKey[]>;

export type RefreshEvent = keyof typeof REFRESH_MAP;

// 调用点只写语义。返回 Promise 以便需要「等刷新落地」的调用点 await(比如撤 optimistic overlay 前)。
//
// `invalidateQueries` 默认只重拉**当前挂载在用**的查询,其余仅标记为旧 —— 所以不需要按当前页收窄,
// 刷一个域的整个前缀天然按页收敛。
export const invalidateFor = (queryClient: QueryClient, event: RefreshEvent): Promise<void> =>
  Promise.all(
    REFRESH_MAP[event].map((queryKey) => queryClient.invalidateQueries({ queryKey })),
  ).then(() => undefined);
