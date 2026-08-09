import type { QueryClient, QueryKey } from "@tanstack/react-query";
import {
  accountKeys,
  portfolioKeys,
  preferenceKeys,
  settingsKeys,
  syncKeys,
  tagKeys,
  tokenKeys,
} from "./keys";

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
   * 一轮同步改的是余额 → 组合域(总额、持仓、走势)与账户域(账户行的市值、上次同步)都跟着变,
   * 所以三个前缀都要刷。
   * **这一条顺带修掉一个既有 bug**:整页刷新只重跑 loader,而 loader 只预取「默认组合」那份 ——
   * 停在非默认组合、或停在自定义 Tab 上时,同步跑完画面根本不动。前缀刷新盖住整个域,三种视图一起更新。
   */
  "sync.round": [syncKeys.all, portfolioKeys.all, accountKeys.all],

  /** 抽屉里的「单独同步」。改的东西和一轮同步一样,只是范围小 —— 前缀是同一批。 */
  "account.sync": [syncKeys.all, portfolioKeys.all, accountKeys.all],

  /**
   * 账户与手记资产的增删改:新建 / 更新 / 归档 / 删除账户、替换凭据,以及手记代币与手记活动的增删改。
   *
   * **必须同时列出组合域的前缀。** 加一个账户不只是账户列表多一行 —— 首页总额、走势、按代币的聚合
   * 全都跟着变。只刷账户域会让总览停在旧数字,而且**不报错**。手记明细那条查询在账户域前缀之下,
   * 一并被盖住,不用单列。
   */
  "account.write": [accountKeys.all, portfolioKeys.all],

  /**
   * 标签的新建 / 改名 / 删除,以及给账户打标签 / 摘标签。
   *
   * **要连组合域一起刷。** 按标签固定的自定义 Tab 是靠标签关联收窄的 —— 摘掉一个标签,
   * 那个 Tab 里就该少一个账户的持仓;只刷标签域会让那个视图停在旧内容。
   */
  "tag.write": [tagKeys.all, portfolioKeys.all],

  /** 新建 / 改名 / 删除组合、设默认组合、把账户移到别的组合 —— 清单、归属、两边的总览与走势都可能变。 */
  "portfolio.write": [portfolioKeys.all],

  /**
   * 自定义 Tab 的新建 / 改目标 / 删除。**只刷 Tab 清单,不刷总览** ——
   * 增删一个 Tab 不改任何余额,连带把昂贵的总览拉一遍是白花钱。
   */
  "portfolio.pin.write": [portfolioKeys.pins()],

  /** 切展示币种:写完 cookie 刷这一条,汇率与格式跟着换。总览数据是 USD 计价的,不受影响。 */
  "preference.currency": [preferenceKeys.currency()],

  /**
   * 切界面语言。**连代币域一起刷**:法币选项的名字是按请求 locale 在服务端本地化的,
   * 不刷的话切完语言那几行还是旧语种。
   */
  "preference.locale": [preferenceKeys.locale(), tokenKeys.all],

  /**
   * 改估值口径(self-first / source-first)。它是**读时重估**,所以历史不用重算,
   * 但总览、走势、账户持仓的现值全部按新口径重来。
   */
  "settings.valuation": [settingsKeys.all, portfolioKeys.all, accountKeys.all],

  /**
   * 导入 / 清理数据。这是唯一一条**什么都可能变**的写:账户、快照、标签、组合全在里面,
   * 所以老老实实把每个域都列上 —— 这里省一个前缀就是一处「导完了某一块画面不动」。
   */
  "settings.data": [
    settingsKeys.all,
    syncKeys.all,
    portfolioKeys.all,
    accountKeys.all,
    tagKeys.all,
  ],

  /** 过期价格后台刷完(SWR 的第二拍):金额跟着变,口径没变。 */
  "prices.refreshed": [portfolioKeys.all, accountKeys.all],
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
