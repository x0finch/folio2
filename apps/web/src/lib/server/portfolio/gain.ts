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

// DeFi 协议行那个数**不是** `Gain`:它按敞口(各腿取绝对值)算分母,没有分段,多一个
// `grossBasis`(见 core/account-view)。**从视图类型上取,不在这里手抄一份** —— 抄的那份迟早
// 跟总览的实现走散,而这两处必须是同一个形状(存进去的就是总览算出来的那个对象)。
type DefiGain = NonNullable<OverviewView["sections"][number]["defi"][number]["gain24h"]>;

/** 组合级 24h 盈亏的返回形状 —— 存进缓存的和读出去的是同一个,所以它得有个名字。 */
export interface PortfolioGain24h {
  portfolio: Gain | null;
  holdings: Record<string, Gain | null>;
  defi: Record<string, DefiGain | null>;
}

/** 账户级 24h 盈亏的返回形状(账户行 + 各余额行)。 */
export interface AccountGain24h {
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
 * 客户端给的 portfolioId 未必可信(可能缺省、也可能是别人的)。
 *
 * **先拿它原样读一次**:命中就等于证明它是真的 —— 这些键只由预计算写,而预计算写的恒是
 * 解析过的 id。于是热路径只有一次 D1 读。miss 才去解析,解析出来不一样再读一次(缺省 /
 * 坏 id 都落在这一支),仍然 miss 才是真的没算过。
 *
 * 解析这一步必须有:少了它,后台补算会把结果写到一个客户端瞎编的键上 —— 那是往
 * `user_cache` 里灌任意行的一条路。
 */
const readByScope = <A>(requested: string | undefined, keyOf: (portfolioId: string) => string) =>
  Effect.gen(function* () {
    if (requested) {
      const direct = yield* readPrecomputed<A>(keyOf(requested));
      if (direct.value) return { ...direct, portfolioId: requested };
    }
    const { selectedId } = yield* resolveScope(requested);
    // 解析出来跟传进来的是同一个 → 上面那次读过了,别再发一遍同样的查询。
    if (requested === selectedId) return { value: undefined, stale: true, portfolioId: selectedId };
    const resolved = yield* readPrecomputed<A>(keyOf(selectedId));
    return { ...resolved, portfolioId: selectedId };
  });

// 补算把**这个组合的全部维度**一次算完,而不是只补被读到的那一个:首页一进来就会同时问
// 组合级与账户级两条,各补各的等于把同一批原料读两遍。一次补全,第二条读到的就是热的。
const scheduleBackfill = (userId: string, portfolioId: string) =>
  backfillForUser(userId, precomputeGain24h(portfolioId));

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
  const pin = toTabPin(data.pin);
  const hit = yield* readByScope<PortfolioGain24h>(data.portfolioId, (id) =>
    portfolioGainKey(id, pin),
  );
  // 缺 / 旧 → 后台补一次。**请求本体不等它**,这次照样把手头有的东西发走。
  if (!hit.value || hit.stale) yield* scheduleBackfill(userId, hit.portfolioId);
  return hit.value ?? emptyPortfolioGain();
});

/** 账户级 24h 盈亏 —— 同上,一次单键读。账户页不吃 pin,所以一个组合一个键。 */
export const handleGetAccountGain24h = Effect.fn("getAccountGain24h")(function* (
  userId: string,
  data: PortfolioScope = {},
) {
  const hit = yield* readByScope<AccountGain24h>(data.portfolioId, accountGainKey);
  if (!hit.value || hit.stale) yield* scheduleBackfill(userId, hit.portfolioId);
  return hit.value ?? emptyAccountGain();
});
