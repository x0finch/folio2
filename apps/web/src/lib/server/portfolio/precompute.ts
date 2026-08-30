import { type CacheWrite, Database } from "@folio/db";
import { Cause, Clock, Effect } from "effect";
import { accountsInView, pinsInView, type TabPin, toTabPin } from "@/lib/core/accounts-in-view";
import { buildScopedOverview, resolveScope } from "./scope";

// 首页那几个数 —— 总额、持仓聚合:**算在同步收官那一刻,读的时候只做「读 + 传」**
//(ADR 0049 裁定 2)。这个文件是那台机器。
//
// **24h 盈亏已退场(FOL-51 / ADR 0050)**:改成浏览器从快照原料两端相减(`snapshot-data` 一次带
// 当前 + 24 小时前两组),不再预计算、不再有 gain 键 / gain 读接口 / pending 轮询。总览本身也已
// 改走原料接口(`snapshot-data`);这里的 `overviewKey` 目前无读者,留给 FOL-52 收编。
//
// **tab 条已退场(FOL-49)**:浏览器从 overview 快照缓存 + `getPortfolioTabPins` + 标签列表
// 用 `computeHomeTabStrip` 现算,不再预计算、不再有 tabstrip 键 / pending 轮询。
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
const PRECOMPUTE_TTL_MS = 90 * 60 * 1000;

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

/** 吃 pin 的那一族:一个维度一个键。 */
const keyOf =
  (family: string): PrecomputeKey =>
  (portfolioId, pin) =>
    `${KEY_GEN}:${family}:${portfolioId}${pinSuffix(pin)}`;

/** 组合总览(总额 + 持仓聚合 + 分区 + 小计)—— 吃 pin。 */
export const overviewKey = keyOf("overview");

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
    // **只剩总览一族**(FOL-51 / FOL-49):24h 盈亏与 tab 条都改浏览器现算;首页总览读的是
    // `snapshot-data`(原料接口),这个 `overviewKey` 目前无读者、留给 FOL-52 收编。
    for (const pin of dimensions) {
      const view = yield* buildScopedOverview({ portfolioId: selectedId, pin: pin ?? undefined });
      at(overviewKey(selectedId, pin), view);
    }
    yield* db.cache.putMany(writes);
    return true;
  }).pipe(
    Effect.catchAllCause((cause) =>
      Effect.as(Effect.logWarning("precompute failed", Cause.pretty(cause)), false),
    ),
  );
