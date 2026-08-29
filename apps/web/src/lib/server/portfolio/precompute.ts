import { type CacheWrite, Database } from "@folio/db";
import { Cause, Clock, Effect } from "effect";
import { defiGainKey, toAccountSections } from "@/lib/core/account-view";
import { accountsInView, pinsInView, type TabPin, toTabPin } from "@/lib/core/accounts-in-view";
import { connectorLabelFallback, platformLogoUrl } from "@/lib/core/logo";
import { connectorPlatformMeta } from "@/lib/server/connectors/platform";
import { backfillForUser } from "@/lib/server/runtime";
import { loadAccountHoldings } from "./account-holdings";
import type { AccountGain24h, DefiGain, PortfolioGain24h } from "./gain";
import type { Gain } from "./gain-24h";
import type { OverviewView } from "./overview-model";
import { buildScopedOverview, type PortfolioScope, resolveScope } from "./scope";
import { kindPresence, resolvePinLabel } from "./tab-strip";

// 首页那几个数 —— 总额、持仓聚合、24h 盈亏、tab 条:**算在同步收官那一刻,读的时候只做
// 「读 + 传」**(ADR 0049 裁定 2)。这个文件是那台机器;`overview.ts` / `gain.ts` / `tabs.ts`
// 是它的三个出口,各自只剩「读哪个键、没有的时候端什么」。
//
// 这几条接口都是「原料大、结果小」的样板:窗口内几千行余额历史、每个账户的整张快照进去,
// 一屏数字出来。原料扔给前端连序列化都超标,而现算合起来远超免费档一次请求的 10ms CPU。
// 所以算的时刻搬到同步收官(`sync/round.ts` 的 `afterRound`,与定时任务同路、CPU 宽松),
// 读接口退化成一次 KV 单键读。
//
// **返回形状一个字没变**:命中回那份存下来的,没算过回空态 —— 而空态本来就是「全新用户」那一支
// 的形状,前端早就渲染得了。
//
// **绝不读时现算。** 没算过 / 算旧了都只把补算交给这次请求的 `waitUntil`(ADR 0049 裁定 3),
// 请求本体不等它 —— 一等,10ms 那道坎就原样回来了。
//
// **键落 `user_cache`,与同步轮同一套约定**(ADR 0048):一个维度一个键、值是 JSON、
// `expires_at` 那一列当心跳/新鲜度用。不建新表的理由与那边逐字相同。
//
// **一个组合的四族键一趟算完、一批写下去。** 不是四台各转各的机器:
//   · 总览与 24h 盈亏吃的是**同一次** `buildScopedOverview` —— 分两次算不只是多花一倍后台
//     CPU,还会让首页那个总额与它旁边的 24h 数字来自两个时刻的价;
//   · 后台补算按 (用户, 组合) 单飞(`backfillForUser`),一把钥匙上只跑得下**一件**活儿 ——
//     四条读接口各排各的补算,后三件会被前一件吞掉,那三个键永远填不上。
//
// —— 「算的时刻 ≠ 看的时刻」这道缝,靠三件事一起收口 ——
//
// ① **输入变了就抬一次失效水位线**(`invalidatePrecomputed`):删账户、归档、挪组合、改手记、
//    改标签、钉/取消 tab、导入、换估值口径、改默认组合、刷价、单账户同步、一轮同步收官 ——
//    这些都让存下来的数不再算数。**旧值仍然端得出去**(读那头看的是「算数没有」,不是「有没有」),
//    界面因此不会空一下,只是顺手补一次。不抬的话它会以「新鲜」的身份被当成对的端上去,最长
//    90 分钟 —— 一个已经删掉的账户还在给总额做贡献,而屏幕上没有任何东西在解释它。
// ② **读的时候把「这个数还在重算」如实说出来**(`pending`)。这是**可选字段**,既有字段的含义
//    一个都没动。没有它的话,前端把空态 / 旧值按 `STALE_TIME.live` 揣 30 秒,而后台补算早在
//    几百毫秒后就落好了 —— 用户盯着一片空白,数据其实就在库里。
// ③ **前端见 `pending` 就短轮询**(`POLL_INTERVAL.precompute`),与同步轮进度那条同一套手法
//    (ADR 0048);而手上连旧值都没有的那一下,取数那层先等一等再交卷(`lib/queries/portfolio.ts`)
//    —— 交白卷会让页面把「还不知道」画成一排 0。

/**
 * 存了多久算旧。cron 每小时一轮,所以正常情况下每个键在过期前就被下一轮盖掉了;
 * 真过期只说明「这个组合好久没同步过」(纯手记用户、上游一直挂着),那时读接口照样直出旧值,
 * 顺手让后台补一次 —— **过期不删、读出带 stale**,与这张表上别的键同一套 SWR 语义。
 */
export const PRECOMPUTE_TTL_MS = 90 * 60 * 1000;

/**
 * 键的**代号**。「什么算数」的判据变了一次(FOL-36:水位线从 24h 盈亏专用改成四族共用,
 * 名字也跟着换),而旧代号下存着的值是按旧判据、对着旧水位线存下来的 —— 新水位线在库里
 * 还不存在(读作 0),它们会一律显得「新鲜」,包括那些在部署前就该失效的。
 *
 * 换代号是唯一不依赖「记得手动清一次库」的作废方式:旧行没人再读,90 分钟后过期躺着。
 * 以后再动存法(值的形状、判据)照此加一代,别在原地改语义。
 */
const KEY_GEN = "pc1";

// 一个维度一个键。默认视图没有 pin 后缀,pin 视图带 `:<kind>:<目标 id>` ——
// 组合 id 是 UUID,不含冒号,所以拼出来的键不会互相撞。
//
// **键里放的是 pin 指向的东西,不是 `tab_pins` 那一行的 id**:读接口收到的就是「按哪个
// connector / tag / 账户收窄」(`PinScopeKey`),它认不得行 id;而同一个目标换一行 pin 重建
// 之后,收窄出来的仍是同一份数,没有理由重算。
const pinSuffix = (pin: TabPin | null): string => {
  if (pin == null) return "";
  if (pin.kind === "connector") return `:connector:${pin.connectorId}`;
  if (pin.kind === "tag") return `:tag:${pin.tagId}`;
  return `:account:${pin.accountId}`;
};

/** 一个键的形状:`pc1:<族>:<组合 id>[:<pin>]`。四族共用这一个拼法,免得各拼各的。 */
export type PrecomputeKey = (portfolioId: string, pin: TabPin | null) => string;

/** 吃 pin 的那两族:一个维度一个键。 */
const keyOf =
  (family: string): PrecomputeKey =>
  (portfolioId, pin) =>
    `${KEY_GEN}:${family}:${portfolioId}${pinSuffix(pin)}`;

/**
 * **不吃 pin** 的那两族:一个组合一个键,pin 那个参数**在这里就被丢掉**。
 *
 * 账户页没有自定义 Tab(入参是 `PortfolioSelectInput`),tab 条本身就是「有哪些 pin」的答案、
 * 不可能按某个 pin 收窄。签名仍收 pin 只是为了跟 `readByScope` 对得上 —— 而「谁也别传 pin 给
 * 它们」这件事**由这里丢掉参数来保证**,不靠每个调用点记得先把 pin 抹掉:少抹一处就是一族键
 * 按 pin 裂成好几个,写的那头只填其中一个,其余永远 `pending`。
 */
const plainKeyOf =
  (family: string): PrecomputeKey =>
  (portfolioId) =>
    `${KEY_GEN}:${family}:${portfolioId}`;

/** 组合总览(总额 + 持仓聚合 + 分区 + 小计)—— 吃 pin。 */
export const overviewKey = keyOf("overview");
/** 组合级 24h 盈亏 —— 吃 pin。 */
export const portfolioGainKey = keyOf("gain");
/** 账户级 24h 盈亏 —— 一个组合一个键。 */
export const accountGainKey = plainKeyOf("gain-accounts");
/** 首页 tab 条 —— 一个组合一个键。 */
export const tabStripKey = plainKeyOf("tabstrip");

/**
 * **失效水位线** —— 「这个组合(或这个用户)的预计算结果,在这一刻之后才算数」。
 *
 * 存一个时间戳,per-portfolio 一个、外加一个整个用户的。写路径改的是它,不是那些值本身。
 *
 * **为什么是水位线而不是「把值标旧」。** 标旧要先有行:e2e 那个 bug 的形状正是「值还没写出来
 * 就被改了」—— 一次冷读的补算在用户建完手记账户之前开工、在之后落库,标旧那一下扫不到任何行,
 * 于是补算把**改动前**的空结果写进去,还带着崭新的 90 分钟 TTL,此后每次读都命中「新鲜的错」。
 * 水位线没有这个洞:它不依赖行在不在,而预计算落的是**开工那一刻**的时间戳 —— 开工早于改动
 * 就恒小于水位线,读那头一眼看出「这份是拿过期原料算的」。窗口是零,不是「很短」。
 *
 * 顺带还便宜了:一行 upsert,不是一次前缀扫描。
 */
export const precomputeMarkKey = (portfolioId: string) => `${KEY_GEN}:mark:${portfolioId}`;
const USER_MARK_KEY = `${KEY_GEN}:mark`;

// 水位线要活得比它守着的值久 —— 它一消失,那些值就重新显得「算数」了。一年足够长到没人碰得到,
// 而 `user_cache` 的过期行本来也只是读出来带个 stale 标记,不会被删掉。
const MARK_TTL_MS = 365 * 24 * 60 * 60 * 1000;

/**
 * **输入变了,已经算好的那份不再算数** —— 抬一次水位线(一行 upsert)。
 *
 * **一条水位线管四族,是刻意的。** 总览、24h 盈亏、账户级盈亏、tab 条吃的原料九成重合
 * (账户、成员、快照、手记、估值口径、价、标签、pin),各立一条的结果必然是「某个写路径
 * 记得抬这条、忘了抬那条」,而症状是一个数对、旁边那个错。代价是标签改个名会顺手让盈亏
 * 也重算一趟 —— 那趟跑在后台,没人在等。
 *
 * 给了 `portfolioId` 就只抬那个组合的。**这一条是必须的,不是优化**:cron 一次 sweep 里
 * 各组合的轮是并发跑的,抬整个用户的水位线会让先收官的组合刚算好的那份当场作废 ——
 * 一趟 sweep 下来除了最后一个组合,其余全是「旧的」,一打开就 `pending`、1 秒一轮询、
 * 各安排一趟全量重算,正好是这一片要从读请求里搬走的那笔 CPU。
 *
 * 不给 = 整个用户(估值口径、导入、改默认组合、connector pin —— 它们确实动了每个组合的数)。
 *
 * **不带 userId**:`cache` 是 per-user 服务,userId 在建它那一刻就吃掉了(ADR 0044)。
 * 所以任何 handler 直接 `yield*` 它就行,不必为此把 userId 塞进签名。
 */
export const invalidatePrecomputed = (portfolioId?: string): Effect.Effect<void, never, Database> =>
  Effect.gen(function* () {
    const now = yield* Clock.currentTimeMillis;
    const key = portfolioId ? precomputeMarkKey(portfolioId) : USER_MARK_KEY;
    yield* (yield* Database).cache.putMany([{ key, value: now, ttlMs: MARK_TTL_MS }]);
  });

/**
 * 「这份数还在后台重算,待会儿再问一次」。
 *
 * **可选字段,既有字段的含义一个都没动** —— 有值就是有值。它只回答另一个问题:你手上这份
 * 是不是终局。缺 / 旧的时候为真,前端据此短轮询(见 `lib/queries/portfolio.ts`);算得好好的
 * 时候整个字段不出现,老的调用方一无所觉。
 *
 * 没有它的后果是实打实的:全新用户、TTL 过期、刚同步完那几秒,读到的都是空态或旧值,
 * 而 react-query 会把它按 `STALE_TIME.live` 揣 30 秒 —— 补算其实几百毫秒就落好了。
 */
export interface Pending {
  pending?: true;
}

/**
 * 落库的形状 —— 结果本身,外加**开工那一刻**的时间戳。
 *
 * `computedAt` 不是给人看的元数据,它是判据:读那头拿它跟失效水位线比,小于就是「拿过期原料
 * 算的」。所以它必须存在值**里面**,而不是靠行上的 `expires_at` —— 后者说的是「存了多久」,
 * 回答不了「这份是改动前算的还是改动后算的」。
 */
interface Stored<A> {
  computedAt: number;
  value: A;
}

// —— 算(只在同步收官与后台补算这两条路上跑)——

/**
 * 总览里那些盈亏字段,摘出来单独存一份。
 *
 * **摘,不是重算** —— 存进 `gain` 键的就是总览那个对象上的同一批数字,所以「首页那个总额」
 * 与「它旁边那个 24h」结构上不可能来自两次不同的计算。
 */
const portfolioGainOf = (view: OverviewView): PortfolioGain24h => {
  const holdings: Record<string, Gain | null> = {};
  for (const h of view.holdings) holdings[h.key] = h.gain24h ?? null;
  const defi: Record<string, DefiGain | null> = {};
  for (const s of view.sections) {
    for (const g of s.defi) defi[defiGainKey(s.account.id, g.protocol)] = g.gain24h ?? null;
  }
  return { portfolio: view.gain24h ?? null, holdings, defi };
};

/**
 * 总览**去掉盈亏字段**的那一份 —— `getPortfolioOverview` 的返回形状一个字没变(#488 票 5
 * 之后它就不带盈亏了,盈亏走自己那条读取)。
 *
 * 之所以是「算一次、摘两份」而不是「按 `withGain` 各算一次」:后者每个维度要把整个窗口的
 * 余额历史再捞一遍、把持仓再聚合一遍,换来的是两份本该相等的数字来自两个时刻。
 */
const withoutGain = ({ gain24h: _portfolio, ...view }: OverviewView): OverviewView => ({
  ...view,
  holdings: view.holdings.map(({ gain24h: _row, ...h }) => h),
  sections: view.sections.map((s) => ({ ...s, defi: s.defi.map(({ gain24h: _g, ...g }) => g) })),
});

/** 账户级盈亏的摘取(账户行 + 各余额行)。归档账户两级都不出现(ADR 0039)。 */
const accountGainOf = (
  view: Effect.Effect.Success<ReturnType<typeof loadAccountHoldings>>,
): AccountGain24h => {
  const accounts: Record<string, Gain | null> = {};
  const balances: Record<string, Gain | null> = {};
  for (const r of view.rows) {
    if (r.archivedAt == null) accounts[r.account.id] = r.gain24h ?? null;
    for (const b of r.balances) {
      if (r.archivedAt != null || b.tokenId == null) continue;
      balances[b.id] = b.gain24h ?? null;
    }
  }
  return { accounts, balances };
};

/**
 * 组合级 24h 盈亏的**现算**。同一条 `buildScopedOverview(..., true)`,只把盈亏字段带出来。
 * 预计算与**对拍测试**用它;读接口不碰。
 */
export const computePortfolioGain24h = (data: PortfolioScope) =>
  Effect.map(buildScopedOverview(data, true), portfolioGainOf);

/** 账户级 24h 盈亏的现算(#493 票 3)。同上,只把盈亏字段带出来。 */
export const computeAccountGain24h = (data: PortfolioScope) =>
  Effect.map(loadAccountHoldings(data, true), accountGainOf);

/**
 * 首页 tab 条的**现算**(#488 票 4)。只回答「这个组合里有没有永续 / DeFi、自定义 Tab 叫什么」。
 * 不富化价格、不算盈亏、不接手记现造 —— 手记只注入现货,不影响这两个 tab 的有无。
 * 标签在服务端解析好(连接器走 registry 的类型名 + 已代理 logo),客户端不再为渲染 tab 名拉目录。
 *
 * **住在这儿而不是 `tabs.ts`**:那边现在只是读接口,而读接口不许再引到这条计算链上来
 * (引了就迟早有人「顺手」在读的时候调它)。
 */
export const computeHomeTabStrip = (data: { portfolioId?: string }) =>
  Effect.gen(function* () {
    const db = yield* Database;
    const { selectedId, defaultId } = yield* resolveScope(data.portfolioId);
    const [allAccounts, snapshots, memberships, pins, tags] = yield* Effect.all(
      [
        db.accounts.list(),
        db.snapshots.latest(),
        db.portfolios.listMemberships(),
        db.tabPins.list(),
        db.tags.list(),
      ],
      { concurrency: 5 },
    );
    const accounts = accountsInView(allAccounts, memberships, selectedId, defaultId);
    const inView = new Set(accounts.map((a) => a.id));
    const sections = snapshots
      .filter((s) => inView.has(s.snapshot.accountId))
      .map((s) =>
        toAccountSections(
          s.balances.map((b) => ({
            id: b.id,
            amount: b.amount,
            usdValue: b.usdValue,
            kind: b.kind,
            metaJson: b.metaJson,
          })),
        ),
      );
    const { hasPerps, hasDefi } = kindPresence(sections);
    // **只摆这个组合里说得通的 pin**(ADR 0034 早就这么定了,实现只筛了内容、没筛名单)。
    // 以前在非默认组合的首页能看到别的组合的自定义 Tab,点进去是空的。
    const shownPins = pinsInView(pins, {
      accounts,
      tagIds: new Set(tags.filter((t) => t.portfolioId === selectedId).map((t) => t.id)),
    });
    const tagName = (id: string) => tags.find((t) => t.id === id)?.name;
    const accountName = (id: string) => allAccounts.find((a) => a.id === id)?.label;
    const connector = (id: string) => {
      const meta = connectorPlatformMeta(id);
      return {
        name: meta?.name ?? connectorLabelFallback(id),
        logo: platformLogoUrl(id, meta?.logo),
      };
    };
    return {
      hasAccounts: accounts.length > 0,
      hasPerps,
      hasDefi,
      pins: shownPins.map((p) => {
        const label = resolvePinLabel(p, { tagName, accountName, connector });
        return {
          id: p.id,
          kind: p.kind,
          connectorId: p.connectorId ?? undefined,
          tagId: p.tagId ?? undefined,
          accountId: p.accountId ?? undefined,
          name: label.name,
          logo: label.logo,
        };
      }),
    };
  });

/** tab 条那份数据的形状 —— 从算它的那个函数推导,不在旁边再手写一份。 */
export type TabStripView = Effect.Effect.Success<ReturnType<typeof computeHomeTabStrip>>;

// —— 维度 ——

/**
 * 这个组合有哪些维度:**默认视图(`null`)+ 每个说得通的 pin**。
 *
 * 写(预计算)与读(冷路径判「这个 pin 在不在」)共用这一个 —— 两边各算一份的话,读会为一个
 * 写永远不会落键的 pin 一直安排补算,而那是客户端一句参数就能拉起来的无界后台工作。
 * 「说得通」的判据是 `pinsInView`,与首页 tab 条同一个纯函数。
 */
const pinDimensions = (portfolioId?: string) =>
  Effect.gen(function* () {
    const db = yield* Database;
    const { selectedId, defaultId } = yield* resolveScope(portfolioId);
    const [allAccounts, memberships, pins, tags] = yield* Effect.all(
      [db.accounts.list(), db.portfolios.listMemberships(), db.tabPins.list(), db.tags.list()],
      { concurrency: 4 },
    );
    const accounts = accountsInView(allAccounts, memberships, selectedId, defaultId);
    const tagIds = new Set(tags.filter((t) => t.portfolioId === selectedId).map((t) => t.id));
    const dimensions: (TabPin | null)[] = [
      null, // 默认视图
      ...pinsInView(pins, { accounts, tagIds }).flatMap((p) => {
        // 行上那三列按 kind 互斥非空(db 那层保证),这里把 null 折成 undefined 交给
        // `toTabPin` 归一 —— 与读接口收到的 `PinScopeKey` 走的是同一个函数,所以
        // 「存的时候拼出的键」与「读的时候拼出的键」不可能各拼各的。
        const pin = toTabPin({
          kind: p.kind,
          connectorId: p.connectorId ?? undefined,
          tagId: p.tagId ?? undefined,
          accountId: p.accountId ?? undefined,
        });
        return pin ? [pin] : []; // 三个目标列都空的坏行(不该有)直接跳过,不为它建一个键
      }),
    ];
    return { selectedId, dimensions };
  });

// —— 存 ——

/**
 * 把一个组合的全部预计算算好存起来 —— **同步一轮收官时顺手做的那件事**。
 *
 * 维度 = 组合 ×(默认视图 + 每个 pin),每个维度一份总览 + 一份盈亏;外加两份不吃 pin 的
 * (账户级盈亏、tab 条)(ADR 0049 裁定 2)。「这个组合里哪些 pin 说得通」走 `pinsInView` ——
 * 与首页 tab 条同一个纯函数,所以「屏幕上摆着的 tab」与「预计算过的维度」不会各算各的。
 *
 * **一次 `putMany`**:D1 没有交互式事务,batch 就是它的原子多写 —— 要么整组维度一起换新,
 * 要么一个都不换,不会出现「总览是这一轮的、盈亏还是上一轮的」。
 *
 * **永不失败,但如实报账**(末尾那道 `catchAllCause` 回 `false`):它挂在同步的收尾上,
 * 而收尾坏了不该让这一轮变成异常收尾;读那头也不依赖它成功 —— 没算过就是空态 + 后台补算。
 * 记一行 warning 留痕,别 `try/catch` 静默吞掉(CODING.md「降级要按类型接,而且要留痕」)。
 *
 * **回一个 `boolean` 而不是 `void`**:调度器要靠它认出「这份数据算不出来」。一直吞掉的话,
 * 键永远填不上 → 读永远 `pending` → 前端每秒一轮询、每轮再排一趟重算,一台永动机。
 */
export const precomputePortfolio = (portfolioId: string) =>
  Effect.gen(function* () {
    const db = yield* Database;
    // **开工那一刻**的时间戳,不是落库那一刻 —— 这一个字决定了那条竞态有没有窗口。
    // 中途有人改了数据(水位线抬到 T,t0 < T < 落库),这份结果带着 t0 存下去就恒小于水位线,
    // 读那头一眼判出「拿过期原料算的」→ 照旧回旧值 + `pending` + 再补一趟。用落库时刻的话,
    // 它会大于 T、显得算数,那份「改动前的数」就带着崭新的 TTL 挂 90 分钟。
    const computedAt = yield* Clock.currentTimeMillis;
    const { selectedId, dimensions } = yield* pinDimensions(portfolioId);

    const writes: CacheWrite[] = [];
    const at = <A>(key: string, value: A): void => {
      writes.push({
        key,
        value: { computedAt, value } satisfies Stored<A>,
        ttlMs: PRECOMPUTE_TTL_MS,
      });
    };
    // **逐个维度串行算。** 并发发出去只是把同一批 D1 往返挤在一起,而这段跑在 `waitUntil` /
    // cron 里,没人在等它。
    //
    // **已知的浪费,刻意留着**:每个维度各自跑一遍 `buildScopedOverview`,而它里面那句
    // `listBalanceHistory(since)` **不按账户收窄** —— 整个窗口的历史全捞回来,再在 JS 里按
    // 这一维的账户集过滤。于是 P 个 pin = P+1 次一模一样的全量扫描(还要乘以组合数)。
    // 真正的修法是把原料读一次、按各维度切,但那要给 `buildScopedOverview` 开一条「收预加载
    // 原料」的路,而它同时也是**对拍测试的被测对象** —— 把那条缝一起动会让「两条路算得一样吗」
    // 这件事失去参照。留到单独一票。
    // 代价的实际大小:pin 数中位是 0(这个循环就一圈)。
    for (const pin of dimensions) {
      const view = yield* buildScopedOverview(
        { portfolioId: selectedId, pin: pin ?? undefined },
        true,
      );
      at(overviewKey(selectedId, pin), withoutGain(view));
      at(portfolioGainKey(selectedId, pin), portfolioGainOf(view));
    }
    at(
      accountGainKey(selectedId, null),
      accountGainOf(yield* loadAccountHoldings({ portfolioId: selectedId }, true)),
    );
    at(tabStripKey(selectedId, null), yield* computeHomeTabStrip({ portfolioId: selectedId }));
    yield* db.cache.putMany(writes);
    return true;
  }).pipe(
    Effect.catchAllCause((cause) =>
      Effect.as(Effect.logWarning("precompute failed", Cause.pretty(cause)), false),
    ),
  );

// —— 读(读接口只走这一段:取值 + 水位线,一次查询,零计算)——

/**
 * 一次读的下场。`portfolioId` 是**补算该写去哪儿**的那个;`fillable` 为假表示「这个键根本
 * 不会被预计算写出来」—— 那时既不该说 `pending`,也不该安排补算。
 */
interface Served<A> {
  value: A | undefined;
  /** 「这份不算数」:没有、坏了、TTL 过期,或者算它的时候用的是已经被改掉的原料。 */
  stale: boolean;
  portfolioId: string;
  fillable: boolean;
}

/**
 * 读一个维度的结果,**连它的两条水位线一起取**(`getMany` 一条查询,不是三条)。
 *
 * 「算数」要同时满足两件事:TTL 没过(那一列),而且**算它的时候没人在改数据**
 * (`computedAt` ≥ 两条水位线)。少了后一半,一次跨越写操作的补算会把改动前的数字带着
 * 崭新的 TTL 存进去,此后 90 分钟每次读都命中「新鲜的错」。
 */
const readPrecomputed = <A>(key: string, portfolioId: string) =>
  Effect.gen(function* () {
    const marks = [USER_MARK_KEY, precomputeMarkKey(portfolioId)];
    const rows = yield* (yield* Database).cache.getMany([key, ...marks]);
    const markOf = (k: string) => {
      const v = rows.get(k)?.value;
      return typeof v === "number" ? v : 0;
    };
    const mark = Math.max(...marks.map(markOf));
    const row = rows.get(key);
    // 存进去的一定是上面那个 `Stored`;真读到不认识的东西就当没算过 —— 下一轮预计算会照常
    // 覆盖它,不该让一条脏缓存把页面弄崩(同 cache store 的坏值口径)。
    const stored = row?.value as Stored<A> | undefined;
    const ok =
      stored != null &&
      typeof stored === "object" &&
      typeof stored.computedAt === "number" &&
      stored.value != null &&
      typeof stored.value === "object";
    if (!ok) return { value: undefined, stale: true, exists: false };
    return {
      value: stored.value,
      stale: row?.stale === true || stored.computedAt < mark,
      exists: true,
    };
  });

/**
 * 客户端给的 portfolioId 与 pin 都未必可信(可能缺省、可能是别人的、可能指着一个已经不在这个
 * 组合里的目标)。这个函数把「读哪个键、补算该写哪个组合、这个键有没有人会来填」一次问清楚,
 * **而且按这三件事各自的必要程度分档收费**:
 *
 *   · 传了 id 且键上那份**新鲜** → **就这一条查询**。命中即证明这个 id 是真的(这些键只由
 *     预计算写,而它写的恒是解析过的 id),新鲜也就证明这个维度还有人在填。这是首屏与轮询
 *     绝大多数时候走的那一档,不该让它去跑六条查询。
 *   · 键上有值但**不算数** → 带 pin 的话再跑四条,问一句「这一维还在不在」。它可能是一个目标
 *     已经被删掉的 pin 留下的旧行:那种键预计算永远不会再覆盖,而 `stale` 恒为真 —— 不问的话
 *     前端会对着一份永远不会变的数一直轮询。
 *   · 键上什么都没有 → 解析组合(两条);带 pin 的再加四条判它说不说得通。
 *
 * 解析那一步不能省:少了它,后台补算会把结果写到一个客户端瞎编的键上 —— 那是往 `user_cache`
 * 里灌任意行的一条路。
 */
const readByScope = <A>(
  requested: string | undefined,
  pin: TabPin | null,
  keyFor: PrecomputeKey,
): Effect.Effect<Served<A>, never, Database> =>
  Effect.gen(function* () {
    // 「这个键还有人会来填吗」。默认视图与不吃 pin 的那两族恒是维度之一,问也是白问;
    // 带 pin 的才值得为它多跑四条查询。
    const fillableAt = (portfolioId: string) =>
      pin == null
        ? Effect.succeed(true)
        : Effect.map(pinDimensions(portfolioId), ({ dimensions }) =>
            dimensions.some((d) => keyFor(portfolioId, d) === keyFor(portfolioId, pin)),
          );

    if (requested) {
      const direct = yield* readPrecomputed<A>(keyFor(requested, pin), requested);
      // **新鲜**:到此为止,就这一条查询 —— 这是轮询与首屏最常走的那一档。
      if (direct.exists && !direct.stale) {
        return { ...direct, portfolioId: requested, fillable: true };
      }
      // **有值但不算数**:值在,不代表还有人会来填它。目标被删掉 / 移出这个组合之后,
      // 那一维就不在 `pinDimensions` 里了,预计算再也不会覆盖这个键 —— 而 `stale` 恒为真。
      // 不问一句就说 `pending`,前端会对着一份永远不会变的数轮询到放弃为止。
      if (direct.exists) {
        return { ...direct, portfolioId: requested, fillable: yield* fillableAt(requested) };
      }
    }
    const { selectedId } = yield* resolveScope(requested);
    const hit =
      requested === selectedId
        ? { value: undefined, stale: true, exists: false }
        : yield* readPrecomputed<A>(keyFor(selectedId, pin), selectedId);
    return {
      ...hit,
      portfolioId: selectedId,
      fillable: hit.exists && !hit.stale ? true : yield* fillableAt(selectedId),
    };
  });

// 补算把**这个组合的全部预计算**一次算完,而不是只补被读到的那一个:首页一进来就会同时问
// 总览、tab 条、两条盈亏,各补各的等于把同一批原料读四遍。一次补全,后面几条读到的就是热的。
//
// 钥匙是 (用户, 组合):`backfillForUser` 据此单飞 + 尾随重跑 + 连败退避,于是一轮同步里
// 几十次刷新最多换来两趟重算,而一份永远算不出来的数据也不会把补算变成永动机(见那边的注释)。
// —— 这也正是四族必须由**一个**函数算完的原因:一把钥匙上只跑得下一件活儿,四条读接口各排
// 各的补算,后来的那三件会被第一件吞掉。
const scheduleBackfill = (userId: string, portfolioId: string) =>
  backfillForUser(userId, portfolioId, precomputePortfolio(portfolioId));

/**
 * 缺 / 不算数 → 端出手头有的(旧值优先,没有才空态)+ 标上 `pending`,并安排一趟后台补算。
 * **请求本体不等它。** 填不上的键(pin 不在这个组合里)是终局,不标 `pending`、不安排补算。
 */
const serve = <A extends Pending>(
  userId: string,
  hit: Served<A>,
  empty: () => A,
): Effect.Effect<A> =>
  Effect.gen(function* () {
    const settled = hit.value != null && !hit.stale;
    if (!settled && hit.fillable) yield* scheduleBackfill(userId, hit.portfolioId);
    const body = hit.value ?? empty();
    return settled || !hit.fillable ? body : { ...body, pending: true as const };
  });

/**
 * 一条读接口的全部内容:**读 + 传**(ADR 0049 裁定 1)。
 *
 * `userId` 显式收一次,理由与 `syncAccount` 那条同一个:补算要**另起一次装配**跑在
 * `waitUntil` 上(与这次请求的响应无关的另一个程序),而 `runEffect` 刻意不把 userId
 * 交给 handler。装配点因此走 `runForUser`(见 ./index)。
 */
export const servePrecomputed = <A extends Pending>(
  userId: string,
  data: PortfolioScope,
  keyFor: (portfolioId: string, pin: TabPin | null) => string,
  empty: () => A,
): Effect.Effect<A, never, Database> =>
  Effect.gen(function* () {
    const hit = yield* readByScope<A>(data.portfolioId, toTabPin(data.pin), keyFor);
    return yield* serve(userId, hit, empty);
  });
