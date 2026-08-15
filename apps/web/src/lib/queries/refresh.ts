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
   * **一次账户写会改四个域,四个前缀一个都不能少。** 这是整张表里跨域最宽的一条:
   * · 账户域 —— 账户行本身。手记明细那条查询在同一前缀之下,不用单列。
   * · 组合域 —— 加一个账户不只是列表多一行,首页总额、走势、按代币的聚合全跟着变。
   * · 同步域 —— **最容易漏的就是它**。同步摘要是**按账户集算出来的**(`lib/sync-status.ts`
   *   的 `summarizeSync`):页头面板的 `N / M`、「未同步」清单里的展示名、以及「立即同步」
   *   到底同步哪些账户,全部来自它。归档 / 删除 / 改名 / 新建之后不刷这一条,面板就停在旧数字,
   *   而「立即同步」还会带着一个已经删掉的账户跑。
   * · 设置域的 `dataStats` —— 它就是「账户数 > 0」,而它决定导入前弹不弹那道确认。不刷的话:
   *   空库时进过一次设置页,再去加账户,回来导入就**跳过了确认弹窗**。只列这一条 key,
   *   不列 `settingsKeys.all` —— 估值口径和 provider key 与账户无关。
   *
   * 四条都不报错,只表现为「改了东西那一块不动」—— 所以宁可多列一个前缀,也别省。
   */
  "account.write": [accountKeys.all, portfolioKeys.all, syncKeys.all, settingsKeys.dataStats()],

  /**
   * 标签的新建 / 改名 / 删除,以及给账户打标签 / 摘标签。
   *
   * **要连组合域一起刷。** 按标签固定的自定义 Tab 是靠标签关联收窄的 —— 摘掉一个标签,
   * 那个 Tab 里就该少一个账户的持仓;只刷标签域会让那个视图停在旧内容。
   */
  "tag.write": [tagKeys.all, portfolioKeys.all],

  /**
   * 新建 / 改名 / 删除组合、设默认组合、把账户移到别的组合 —— 清单、归属、两边的总览与走势都可能变。
   *
   * **要连标签域一起刷。** Tag 归属 Portfolio,所以组合域的两处写会**连带删掉标签关联**:
   * 移动账户时 `portfolioStore.move` 显式 `delete(accountTags)`(账户不能挂别的组合的 Tag),
   * 删组合时 tags 经外键 cascade 清掉。只刷组合域的话,账户行的徽标和抽屉里的标签选择器
   * 会继续显示服务端**已经删掉**的标签 —— 幽灵标签,而且不报错。
   */
  "portfolio.write": [portfolioKeys.all, tagKeys.all],

  /**
   * 自定义 Tab 的新建 / 改目标 / 删除。**只刷 tab 条那份元信息,不刷总览** ——
   * 增删一个 Tab 不改任何余额,连带把昂贵的总览拉一遍是白花钱。
   *
   * 它带着每个 pin 的显示标签(在服务端解析好的),所以改了 pin 的目标必须刷到它,否则会出现
   * 「pin 已经改指到别的标签、tab 上还写着旧名字」——不报错,只是显示的是上一次的答案。
   *
   * (曾经这里还列着 `portfolioKeys.pins()`。#488 把 pin 清单并进了 tab 条那条轻请求,
   * 那个前缀下**再没有任何查询注册** —— 留着就是刷一个空 key,而测试还煞有介事地钉着它。)
   */
  "portfolio.pin.write": [portfolioKeys.tabMetaAll()],

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
   * 导入数据。这是唯一一条**什么都可能变**的写:账户、快照、标签、组合全在里面,
   * 所以老老实实把每个域都列上 —— 这里省一个前缀就是一处「导完了某一块画面不动」。
   *
   * (设置页只有导出与导入两条路,没有「清理数据」—— 之前这里写着「导入 / 清理」,是描述多写了一项。)
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
