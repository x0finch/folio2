import { type CacheWrite, Database } from "@folio/db";
import { Cause, Effect, Option } from "effect";
import { defiGainKey } from "@/lib/core/account-view";
import { accountsInView, pinsInView, type TabPin, toTabPin } from "@/lib/core/accounts-in-view";
import { backfillForUser } from "@/lib/server/runtime";
import { loadAccountHoldings } from "./account-holdings";
import type { Gain } from "./gain-24h";
import type { OverviewView } from "./overview-model";
import { buildScopedOverview, type PortfolioScope, resolveScope } from "./scope";

// 24h 盈亏:**算在同步收官那一刻,读的时候只做「读 + 传」**(ADR 0049 裁定 2)。
//
// 这条接口是「原料大、结果小」的样板:窗口内几千行余额历史进去,几十个数字出来。原料扔给前端
// 连序列化都超标,而现算要 6.1ms CPU —— 免费档一次请求只有 10ms,加上框架杂务必然被掐。
// 所以算的时刻搬到同步收官(`sync/round.ts` 的 `afterRound`,与定时任务同路、CPU 宽松),
// 读接口退化成一次 KV 单键读。
//
// **返回形状一个字没变**:命中回那份存下来的,没算过回空态 —— 而空态本来就是「全新用户」那一支
// 的形状(`{ portfolio: null, holdings: {}, defi: {} }`),前端早就渲染得了。
//
// **绝不读时现算。** 没算过 / 算旧了都只把补算交给这次请求的 `waitUntil`(ADR 0049 裁定 3),
// 请求本体不等它 —— 一等,10ms 那道坎就原样回来了。
//
// **键落 `user_cache`,与同步轮同一套约定**(ADR 0048):一个维度一个键、值是 JSON、
// `expires_at` 那一列当心跳/新鲜度用。不建新表的理由与那边逐字相同。
//
// —— 「算的时刻 ≠ 看的时刻」这道缝,靠三件事一起收口 ——
//
// ① **输入变了就把键标旧**(`invalidateGain24h`):删账户、归档、挪组合、改手记、换估值口径、
//    刷价、一轮同步收官 —— 这些都让存下来的数不再可信。**标旧不是删**:读那头照样先给旧的,
//    界面不会空一下,只是顺手补一次。不标的话它会以 `stale === false` 的身份被当成对的端上去,
//    最长 90 分钟 —— 一个已经删掉的账户还在给 24h 数字做贡献,而屏幕上没有任何东西在解释它。
// ② **读的时候把「这个数还在重算」如实说出来**(`pending`)。这是**新加的可选字段**,既有字段
//    的含义一个都没动。没有它的话,前端把空态 / 旧值按 `STALE_TIME.live` 揣 30 秒,而后台补算
//    早在几百毫秒后就落好了 —— 用户盯着一片空白,数据其实就在库里。
// ③ **前端见 `pending` 就短轮询**(`POLL_INTERVAL.gain`),与同步轮进度那条同一套手法(ADR 0048)。

/**
 * 存了多久算旧。cron 每小时一轮,所以正常情况下每个键在过期前就被下一轮盖掉了;
 * 真过期只说明「这个组合好久没同步过」(纯手记用户、上游一直挂着),那时读接口照样直出旧值,
 * 顺手让后台补一次 —— **过期不删、读出带 stale**,与这张表上别的键同一套 SWR 语义。
 */
export const GAIN_PRECOMPUTE_TTL_MS = 90 * 60 * 1000;

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

const portfolioGainKey = (portfolioId: string, pin: TabPin | null) =>
  `gain24h:${portfolioId}${pinSuffix(pin)}`;

// 账户级**不吃 pin**(账户页没有自定义 Tab,入参是 `PortfolioSelectInput`),所以一个组合一个键。
// 前缀另起一个,免得跟上面那条的 `:account:<账户 id>` 后缀读起来像同一族。
const accountGainKey = (portfolioId: string) => `gain24h-accounts:${portfolioId}`;

// 两族键共同的前缀 —— 标旧那一下按它一把扫。
const GAIN_KEY_PREFIX = "gain24h";

/**
 * **输入变了,存下来的数不再可信** —— 把这个用户全部维度的键就地标旧(一条 UPDATE)。
 *
 * 调用方是那些会改动「组合值多少」的写:删 / 归档 / 改名账户、挪组合、手记账本的增删改、
 * 估值口径、刷价,以及一轮同步收官。**它们不必知道是哪个组合、哪些维度** —— 逐个算清楚要
 * 三四条查询和一份会跟 `pinsInView` 走散的名单,而一条 `substr` 前缀 UPDATE 是常数成本。
 * 多标旧几个键的代价只是「下次有人看那个组合时多补算一次」,而补算只由**读**触发:
 * 没人看的组合一分钱都不花。
 *
 * **为什么不删。** 删了读到的是「没算过」→ 界面先空一下再长出来;标旧读到的是「旧的,正在重算」→
 * 数字先旧后新。后者才是这次写操作的真实语义 —— 值变了,不是值没有了。
 *
 * **不带 userId**:`cache` 是 per-user 服务,userId 在建它那一刻就吃掉了(ADR 0044)。
 * 所以任何 handler 直接 `yield*` 它就行,不必为此把 userId 塞进签名。
 */
export const invalidateGain24h = (): Effect.Effect<void, never, Database> =>
  Effect.flatMap(Database, (db) => db.cache.expire(GAIN_KEY_PREFIX));

// DeFi 协议行那个数**不是** `Gain`:它按敞口(各腿取绝对值)算分母,没有分段,多一个
// `grossBasis`(见 core/account-view)。**从视图类型上取,不在这里手抄一份** —— 抄的那份迟早
// 跟总览的实现走散,而这两处必须是同一个形状(存进去的就是总览算出来的那个对象)。
type DefiGain = NonNullable<OverviewView["sections"][number]["defi"][number]["gain24h"]>;

/**
 * 「这份数还在后台重算,待会儿再问一次」。
 *
 * **新加的可选字段,既有字段的含义一个都没动** —— 有值就是有值,`null` 仍然是「算不出」。
 * 它只回答另一个问题:你手上这份是不是终局。缺 / 旧的时候为真,前端据此短轮询(见
 * `lib/queries/portfolio.ts`);算得好好的时候整个字段不出现,老的调用方一无所觉。
 *
 * 没有它的后果是实打实的:全新用户、TTL 过期、刚同步完那几秒,读到的都是空态或旧值,
 * 而 react-query 会把它按 `STALE_TIME.live` 揣 30 秒 —— 补算其实几百毫秒就落好了。
 */
interface Pending {
  pending?: true;
}

/** 组合级 24h 盈亏的返回形状 —— 存进缓存的和读出去的是同一个,所以它得有个名字。 */
export interface PortfolioGain24h extends Pending {
  portfolio: Gain | null;
  holdings: Record<string, Gain | null>;
  defi: Record<string, DefiGain | null>;
}

/** 账户级 24h 盈亏的返回形状(账户行 + 各余额行)。 */
export interface AccountGain24h extends Pending {
  accounts: Record<string, Gain | null>;
  balances: Record<string, Gain | null>;
}

// 空态 = 「还没算过」。**每次现造一个新对象**:调用方拿到的是响应体,共用一份常量的话,
// 任何一处顺手往上挂个字段都会污染下一次请求。
const emptyPortfolioGain = (): PortfolioGain24h => ({ portfolio: null, holdings: {}, defi: {} });
const emptyAccountGain = (): AccountGain24h => ({ accounts: {}, balances: {} });

// —— 算(只在同步收官与后台补算这两条路上跑)——

/**
 * 组合级 24h 盈亏的**现算**。同一条 `buildScopedOverview(..., true)`,只把盈亏字段带出来。
 *
 * #488 票 5 之前这就是读接口的全部内容;它现在只被预计算与后台补算调用,读接口不碰它。
 */
export const computePortfolioGain24h = (data: PortfolioScope) =>
  Effect.gen(function* () {
    const view = yield* buildScopedOverview(data, true);
    const holdings: Record<string, Gain | null> = {};
    for (const h of view.holdings) holdings[h.key] = h.gain24h ?? null;
    const defi: Record<string, DefiGain | null> = {};
    for (const s of view.sections) {
      for (const g of s.defi) {
        defi[defiGainKey(s.account.id, g.protocol)] = g.gain24h ?? null;
      }
    }
    return { portfolio: view.gain24h ?? null, holdings, defi };
  });

/**
 * 账户级 24h 盈亏的**现算**(#493 票 3)。同一条 `loadAccountHoldings(scope, true)`,
 * 只把盈亏字段带出来。归档账户两级都不出现(ADR 0039:封存的数没有「今天涨了多少」)。
 */
export const computeAccountGain24h = (data: PortfolioScope) =>
  Effect.gen(function* () {
    const view = yield* loadAccountHoldings(data, true);
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
  });

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
 * 把一个组合的全部维度算好存起来 —— **同步一轮收官时顺手做的那件事**。
 *
 * 维度 = 组合 ×(默认视图 + 每个 pin),外加一份不吃 pin 的账户级(ADR 0049 裁定 2)。
 * 「这个组合里哪些 pin 说得通」走 `pinsInView` —— 与首页 tab 条同一个纯函数,所以
 * 「屏幕上摆着的 tab」与「预计算过的维度」不会各算各的。
 *
 * **一次 `putMany`**:D1 没有交互式事务,batch 就是它的原子多写 —— 要么整组维度一起换新,
 * 要么一个都不换,不会出现「默认视图是这一轮的、某个 tab 还是上一轮的」。
 *
 * **永不失败**(末尾那道 `catchAllCause`):它挂在同步的收尾上,而收尾坏了不该让这一轮变成
 * 异常收尾;读那头也不依赖它成功 —— 没算过就是空态 + 后台补算。记一行 warning 留痕,
 * 别 `try/catch` 静默吞掉(CODING.md「降级要按类型接,而且要留痕」)。
 */
export const precomputeGain24h = (portfolioId: string) =>
  Effect.gen(function* () {
    const db = yield* Database;
    const { selectedId, dimensions } = yield* pinDimensions(portfolioId);

    const writes: CacheWrite[] = [];
    // **逐个维度串行算。** 每个维度都要把窗口历史读一遍,并发发出去只是把同一批 D1 往返挤在
    // 一起 —— 而这段跑在 `waitUntil` / cron 里,没人在等它。绝大多数用户 pin 数为 0,
    // 这个循环就一圈。
    for (const pin of dimensions) {
      const value = yield* computePortfolioGain24h({
        portfolioId: selectedId,
        pin: pin ?? undefined,
      });
      writes.push({
        key: portfolioGainKey(selectedId, pin),
        value,
        ttlMs: GAIN_PRECOMPUTE_TTL_MS,
      });
    }
    writes.push({
      key: accountGainKey(selectedId),
      value: yield* computeAccountGain24h({ portfolioId: selectedId }),
      ttlMs: GAIN_PRECOMPUTE_TTL_MS,
    });
    yield* db.cache.putMany(writes);
  }).pipe(
    Effect.catchAllCause((cause) =>
      Effect.logWarning("gain24h precompute failed", Cause.pretty(cause)),
    ),
  );

// —— 读(读接口只走这一段:一次单键读,零计算)——

/**
 * 读一个维度的预计算结果。
 *
 * 三种下场:**没有**(从没算过 / 值坏了)、**有但旧了**、**有且新鲜**。前两种都要补算,
 * 区别只在「这次回什么」——旧值照样直出(SWR:先给旧的,后台去对齐),没有就回空态。
 */
const readPrecomputed = <A>(key: string) =>
  Effect.gen(function* () {
    const entry = yield* (yield* Database).cache.get(key);
    return Option.match(entry, {
      onNone: () => ({ value: undefined, stale: true }) as { value: A | undefined; stale: boolean },
      // 存进去的一定是上面两个 compute 的产物;真读到不认识的东西就当没算过 ——
      // 下一轮预计算会照常覆盖它,不该让一条脏缓存把页面弄崩(同 cache store 的坏值口径)。
      onSome: (e) => ({
        value: e.value != null && typeof e.value === "object" ? (e.value as A) : undefined,
        stale: e.stale,
      }),
    });
  });

/**
 * 一次读的下场。`portfolioId` 是**补算该写去哪儿**的那个(已解析);`fillable` 为假表示
 * 「这个键根本不会被预计算写出来」—— 那时既不该说 `pending`,也不该安排补算。
 */
interface Served<A> {
  value: A | undefined;
  stale: boolean;
  portfolioId: string;
  fillable: boolean;
}

/**
 * 客户端给的 portfolioId 与 pin 都未必可信(可能缺省、可能是别人的、可能指着一个已经不在这个
 * 组合里的目标)。这个函数把「读哪个键、补算该写哪个组合、这个键有没有人会来填」一次问清楚。
 *
 * **热路径只有一次 D1 读**:传了 id 且读到**新鲜**值 → 直接返回。命中即证明这个 id 是真的
 * (这些键只由预计算写,而预计算写的恒是解析过的 id)。
 *
 * **旧值不走这条捷径**(这是个 bug 修复,不是优化取舍):组合被删之后它的键还留着,
 * 而预计算再也不会写它 —— 短路的话就成了「永远旧、每次请求安排一趟写到别的键上的补算」,
 * 一份永远追不上的无界后台工作。所以只要不新鲜就老实解析一次。
 *
 * 解析这一步还有第二个理由:少了它,后台补算会把结果写到一个客户端瞎编的键上 —— 那是往
 * `user_cache` 里灌任意行的一条路。
 */
const readByScope = <A>(
  requested: string | undefined,
  pin: TabPin | null,
  keyOf: (portfolioId: string, pin: TabPin | null) => string,
): Effect.Effect<Served<A>, never, Database> =>
  Effect.gen(function* () {
    if (requested) {
      const direct = yield* readPrecomputed<A>(keyOf(requested, pin));
      if (direct.value && !direct.stale) {
        return { ...direct, portfolioId: requested, fillable: true };
      }
    }
    // 冷路径:解析组合,并且**顺便问清这个 pin 在不在这个组合里**。两件事共用同一批读
    // (`pinDimensions` 就是预计算枚举维度用的那一个),所以判据不可能与写那头走散。
    const { selectedId, dimensions } = yield* pinDimensions(requested);
    // 这个 pin 预计算会不会给它落键。不会的话,「空」就是它的终局答案 —— 那个视图里本来就
    // 一个账户都没有。说成 `pending` 会让前端一直轮询一个永远填不上的键,而每一轮都安排一趟
    // 全量重算:一句客户端参数换来无界的后台工作。
    const fillable = dimensions.some((d) => keyOf(selectedId, d) === keyOf(selectedId, pin));
    const resolved = yield* readPrecomputed<A>(keyOf(selectedId, pin));
    return { ...resolved, portfolioId: selectedId, fillable };
  });

// 补算把**这个组合的全部维度**一次算完,而不是只补被读到的那一个:首页一进来就会同时问
// 组合级与账户级两条,各补各的等于把同一批原料读两遍。一次补全,第二条读到的就是热的。
//
// 钥匙是 (用户, 组合):`backfillForUser` 据此单飞 + 尾随重跑,于是一轮同步里几十次刷新
// 最多换来两趟重算,而不是几十趟(见那边的注释)。
const scheduleBackfill = (userId: string, portfolioId: string) =>
  backfillForUser(userId, portfolioId, precomputeGain24h(portfolioId));

/**
 * 缺 / 旧 → 端出手头有的(旧值优先,没有才空态)+ 标上 `pending`,并安排一趟后台补算。
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
 * 组合级 24h 盈亏 —— **读 + 传,一次单键读**(ADR 0049 裁定 1)。
 *
 * `userId` 显式收一次,理由与 `syncAccount` 那条同一个:补算要**另起一次装配**跑在
 * `waitUntil` 上(与这次请求的响应无关的另一个程序),而 `runEffect` 刻意不把 userId
 * 交给 handler。装配点因此走 `runForUser`(见 ./index)。
 */
export const handleGetPortfolioGain24h = Effect.fn("getPortfolioGain24h")(function* (
  userId: string,
  data: PortfolioScope,
) {
  const hit = yield* readByScope<PortfolioGain24h>(
    data.portfolioId,
    toTabPin(data.pin),
    portfolioGainKey,
  );
  return yield* serve(userId, hit, emptyPortfolioGain);
});

/** 账户级 24h 盈亏 —— 同上,一次单键读。账户页不吃 pin,所以一个组合一个键。 */
export const handleGetAccountGain24h = Effect.fn("getAccountGain24h")(function* (
  userId: string,
  data: PortfolioScope = {},
) {
  // 账户级只有「默认视图」一个维度,所以 pin 恒为 null —— 键里也没有它的位置。
  const hit = yield* readByScope<AccountGain24h>(data.portfolioId, null, accountGainKey);
  return yield* serve(userId, hit, emptyAccountGain);
});
