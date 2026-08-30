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
//
// **加一条 / 改一条时的判据,只有一句:这次写之后,服务端哪些读会返回不同的东西?**
// 不是「这个操作归哪个域管」。两者常常不一样,而差出来的那部分正好是漏刷:
// 账户写归账户域,却把同步摘要和 `dataStats` 一起改了;移动账户归组合域,却顺手删了标签关联。
// 判断方法是往下追一层到 `lib/server/*` 与 `packages/db` 的写实现,看它到底动了哪些表 /
// 哪些读会因此变 —— 光看调用点的名字看不出来。
//
// FOL-59:前缀对齐原子资源键 —— 快照(`portfolio.snapshots`)、富化(`tokens.enrichment`)等,
// 不再刷已删除的胖读键(`overview` / `holdings`)。
export const REFRESH_MAP = {
  /**
   * 一轮同步跑完。**失败也算**:同步本身可能仍在服务端跑(waitUntil),
   * 而且部分账户的快照可能已经落库了。
   *
   * 刷:同步轮次、快照原料、账户列表(页头摘要与「立即同步」账户集)、富化现价。
   */
  "sync.round": [
    syncKeys.all,
    portfolioKeys.snapshotsPrefix(),
    accountKeys.all,
    tokenKeys.enrichment(),
  ],

  /** 抽屉里的「单独同步」。改的东西和一轮同步一样,只是范围小 —— 前缀是同一批。 */
  "account.sync": [
    syncKeys.all,
    portfolioKeys.snapshotsPrefix(),
    accountKeys.all,
    tokenKeys.enrichment(),
  ],

  /**
   * 账户与手记资产的增删改:新建 / 更新 / 归档 / 删除账户、替换凭据,以及手记代币与手记活动的增删改。
   *
   * 账户行本身 + 同步轮次(页头摘要) + dataStats + 手记法币身份。快照要等下一轮同步才变,这里不刷。
   */
  "account.write": [
    accountKeys.all,
    syncKeys.all,
    settingsKeys.dataStats(),
    portfolioKeys.fiatRefsPrefix(),
    tokenKeys.enrichment(),
  ],

  /**
   * 归档 / 解归档:封存快照(manual) + 解 pin —— 除 `account.write` 外还要刷快照与 tab 条。
   */
  "account.archive": [
    accountKeys.all,
    syncKeys.all,
    settingsKeys.dataStats(),
    portfolioKeys.fiatRefsPrefix(),
    tokenKeys.enrichment(),
    portfolioKeys.snapshotsPrefix(),
    portfolioKeys.tabs(),
  ],

  /**
   * 标签的新建 / 改名 / 删除,以及给账户打标签 / 摘标签。
   *
   * **标签域要刷**:标签定义与账户关联变了,徽标、标签选择器、tab 条的每档小计(客户端按
   * 标签关联 + 缓存的总览现算)都跟着变。
   *
   * 首页总览已改原子 query(FOL-56):tag pin 内容在浏览器按 `accountTagLinks` 收窄账户,
   * 不必 invalidate 快照键 —— 只刷标签域即可。
   */
  "tag.write": [tagKeys.all],

  /**
   * 新建 / 改名 / 删除组合、设默认组合、把账户移到别的组合 —— 清单、归属、两边的总览与走势都可能变。
   *
   * **要连标签域一起刷。** Tag 归属 Portfolio,所以组合域的两处写会**连带删掉标签关联**:
   * 移动账户时 `portfolioStore.move` 显式 `delete(accountTags)`(账户不能挂别的组合的 Tag),
   * 删组合时 tags 经外键 cascade 清掉。只刷组合域的话,账户行的徽标和抽屉里的标签选择器
   * 会继续显示服务端**已经删掉**的标签 —— 幽灵标签,而且不报错。
   *
   * **账户域与同步域也要刷**(ADR 0047 之后新欠的账):账户页那几份数据现在是**服务端按组合筛好的**,
   * 移动账户 / 删组合(成员退回默认)直接改了「哪个组合里有哪些账户」—— 不刷的话,被移走的账户
   * 还留在旧组合的列表里,「移到组合」的绿勾也画在旧组合上。改造前这条靠「刷组合域 → 归属表变 →
   * 客户端重筛」兜着,归属表不下发之后那条路没有了。页头的同步摘要(`N / M` 与清单)同理 ——
   * 它在服务端按组合收口更早(#530),账户/快照键失效后面板跟着变。
   */
  "portfolio.write": [portfolioKeys.all, tagKeys.all, accountKeys.all, syncKeys.all],

  /**
   * 自定义 Tab 的新建 / 改目标 / 删除。**只刷 tab 条,不刷总览** ——
   * 增删一个 Tab 不改任何余额,连带把昂贵的总览拉一遍是白花钱。
   */
  "portfolio.pin.write": [portfolioKeys.tabs()],

  /** 切展示币种:写完 cookie 刷这一条,汇率与格式跟着换。总览数据是 USD 计价的,不受影响。 */
  "preference.currency": [preferenceKeys.currency()],

  /**
   * 切界面语言。**连代币域一起刷**:法币选项的名字是按请求 locale 在服务端本地化的,
   * 不刷的话切完语言那几行还是旧语种。
   */
  "preference.locale": [preferenceKeys.locale(), tokenKeys.all],

  /**
   * 改估值口径(self-first / source-first)。它是**读时重估**,所以历史不用重算,
   * 但总览、走势、账户持仓的现值全部按新口径重来 —— 口径本身在 settings query 里,
   * 富化字典与快照原料不变,但浏览器合并会重算。
   */
  "settings.valuation": [settingsKeys.valuation()],

  /**
   * 导入数据。这是唯一一条**什么都可能变**的写:账户、快照、标签、组合全在里面,
   * 所以老老实实把每个域都列上 —— 这里省一个前缀就是一处「导完了某一块画面不动」。
   */
  "settings.data": [
    settingsKeys.all,
    syncKeys.all,
    portfolioKeys.all,
    accountKeys.all,
    tagKeys.all,
    tokenKeys.enrichment(),
  ],

  /** 过期价格后台刷完(SWR 的第二拍):富化字典里的现价变了,浏览器合并后金额跟着变。 */
  "prices.refreshed": [tokenKeys.enrichment()],
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
