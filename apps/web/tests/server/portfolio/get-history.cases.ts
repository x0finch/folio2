import { Database } from "@folio/db";
import { Oracle } from "@folio/oracle";
import { Effect } from "effect";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { accountIdsInView, accountsInView } from "@/lib/core/accounts-in-view";
import { buildPortfolioHistory, toPortfolioCurve } from "@/lib/core/history";
import { isManual } from "@/lib/core/manual";
import { deriveLiveAccountTotals, overviewEnrichIds } from "@/lib/core/portfolio";
import { injectManualSnapshots, loadManualHistoryRows } from "@/lib/server/manual/store";
import { handleGetPortfolioHistory } from "@/lib/server/portfolio/get-history";
import { PortfolioSelectInput, resolveScope } from "@/lib/server/portfolio/scope";
import { db } from "../_kit/db";
import { blockOutbound } from "../_kit/outbound";
import { call, readOverview } from "../_kit/run";
import { DAY, seedAccount, seedManualAccount, seedSnapshot } from "../_kit/seed";
import { freshUser, otherUser } from "../_kit/user";

// 合并进 portfolio/index.test.ts 跑(#527 后续件 2):每个 vitest 文件要在 workerd 里
// 重新评估整张 import 图(实测 ~9s/文件),按目录合并把这笔钱只付一次。
describe("portfolio/get-history", () => {
  // #527 · getPortfolioHistory
  //
  // **FOL-38 之后这条接口只发原料**(ADR 0049):快照点 + 归档时刻,曲线由浏览器算。
  // 所以下面每条要看曲线的用例都走 `curve()` —— 它把页面上那两行照抄一遍(读接口 → 装配),
  // 断言的仍然是「屏幕上那条线」,不是接口的中间产物。
  const USER = "h-pf-history";
  const BTC = "token-btc";
  const ETH = "token-eth";

  let NOW = 0;
  const ago = (ms: number) => NOW - ms;

  beforeEach(async () => {
    blockOutbound();
    await freshUser(USER);
    await freshUser(otherUser(USER));
    NOW = Date.now();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  /** 页面那两行:曲线接口给原料,总览按账户那张表凑出末点。 */
  const curve = async (data: { portfolioId?: string } = {}) => {
    const raw = await call(USER, handleGetPortfolioHistory(data));
    // 两边各自演进后的合流:读走预计算那条(这一支的形状),末点防呆收整份总览(底座那一支的形状)。
    const overview = await readOverview(USER, data);
    return toPortfolioCurve(raw, overview);
  };

  describe("getPortfolioHistory", () => {
    it("两个账户各有快照 → 曲线按时间升序", async () => {
      const a = await seedAccount(USER, "甲", "bitcoin");
      const b = await seedAccount(USER, "乙", "binance");
      await seedSnapshot(USER, a.id, ago(3 * DAY), [{ tokenId: BTC, amount: 1, usdValue: 100 }]);
      await seedSnapshot(USER, b.id, ago(3 * DAY), [{ tokenId: ETH, amount: 1, usdValue: 50 }]);
      await seedSnapshot(USER, a.id, ago(DAY), [{ tokenId: BTC, amount: 1, usdValue: 120 }]);
      await seedSnapshot(USER, b.id, ago(DAY), [{ tokenId: ETH, amount: 1, usdValue: 60 }]);

      const series = await curve();

      const times = series.map((p) => p.t);
      expect([...times].sort((x, y) => x - y)).toEqual(times);
      expect(series.length).toBeGreaterThanOrEqual(2);
    });

    it("切到只含一个账户的 Portfolio → 曲线只含那一个", async () => {
      const def = await db(USER).portfolios.ensureDefault();
      const other = await db(USER).portfolios.create({ name: "另一个" });
      const a = await seedAccount(USER, "甲", "bitcoin");
      const b = await seedAccount(USER, "乙", "binance");
      await db(USER).portfolios.assignAccount(a.id, def.id);
      await db(USER).portfolios.assignAccount(b.id, other.id);
      await seedSnapshot(USER, a.id, ago(2 * DAY), [{ tokenId: BTC, amount: 1, usdValue: 100 }]);
      await seedSnapshot(USER, b.id, ago(2 * DAY), [{ tokenId: ETH, amount: 1, usdValue: 900 }]);
      await seedSnapshot(USER, a.id, ago(DAY), [{ tokenId: BTC, amount: 1, usdValue: 100 }]);
      await seedSnapshot(USER, b.id, ago(DAY), [{ tokenId: ETH, amount: 1, usdValue: 900 }]);

      const series = await curve({ portfolioId: other.id });

      // 只含乙 → 每个点都是 900 那一档,不含甲的 100。
      expect(series.every((p) => p.total >= 900)).toBe(true);
      // 别人组合的行连出门都没有 —— 作用域在服务端定(ADR 0047),不是发出去再由前端筛。
      const raw = await call(USER, handleGetPortfolioHistory({ portfolioId: other.id }));
      expect(raw.rows.every((r) => r.accountId === b.id)).toBe(true);
    });

    it("某账户净值为负 → 相加如实,组合曲线可以为负", async () => {
      const a = await seedAccount(USER, "永续", "hyperliquid");
      await seedSnapshot(USER, a.id, ago(2 * DAY), [
        { tokenId: BTC, amount: 1, usdValue: -300, kind: "perp_equity" },
      ]);
      await seedSnapshot(USER, a.id, ago(DAY), [
        { tokenId: BTC, amount: 1, usdValue: -300, kind: "perp_equity" },
      ]);

      const series = await curve();

      expect(series.length).toBeGreaterThan(0);
      expect(series.some((p) => p.total < 0)).toBe(true);
    });

    it("全新用户 → 空曲线,不报错", async () => {
      expect(await curve()).toEqual([]);
    });

    it("portfolioId 传别人的 → 退回默认", async () => {
      const theirPf = await db(otherUser(USER)).portfolios.ensureDefault();
      const mine = await seedAccount(USER, "我的", "bitcoin");
      await seedSnapshot(USER, mine.id, ago(2 * DAY), [{ tokenId: BTC, amount: 1, usdValue: 100 }]);
      await seedSnapshot(USER, mine.id, ago(DAY), [{ tokenId: BTC, amount: 1, usdValue: 100 }]);

      const series = await curve({ portfolioId: theirPf.id });

      expect(series.length).toBeGreaterThan(0);
      expect(series.every((p) => p.total === 100)).toBe(true);
    });

    it("入参缺省 → schema 给出默认值", () => {
      expect(PortfolioSelectInput.parse(undefined)).toEqual({});
    });

    // FOL-38 验收 ① —— 响应里只有原料,没有算好的曲线。
    //
    // 对抗性的地方在于「原料点数与曲线点数几乎一样多」:光看长度分不出这条接口有没有偷偷
    // 聚合。所以断言的是形状与内容 —— 有 `rows`(每行带 accountId,还没合并同刻)、没有 `series`。
    it("接口只发原料:每账户一行,没有算好的曲线", async () => {
      const a = await seedAccount(USER, "甲", "bitcoin");
      const b = await seedAccount(USER, "乙", "binance");
      await seedSnapshot(USER, a.id, ago(2 * DAY), [{ tokenId: BTC, amount: 1, usdValue: 100 }]);
      await seedSnapshot(USER, b.id, ago(2 * DAY), [{ tokenId: ETH, amount: 1, usdValue: 50 }]);

      const raw = await call(USER, handleGetPortfolioHistory({ range: "30d" }));

      expect(Object.keys(raw).sort()).toEqual(["archivedAt", "liveAccountIds", "rows", "sampled"]);
      expect(raw.sampled).toBe(false);
      // 同一时刻的两个账户各占一行(曲线会把它们并成一个点)—— 这就是「没聚合」。
      expect(raw.rows).toHaveLength(2);
      expect(raw.rows.map((r) => r.accountId).sort()).toEqual([a.id, b.id].sort());
    });

    // FOL-38 验收 ② —— 对拍:同一份数据,老那条服务端算法与「发原料 + 浏览器算」一个点都不差。
    //
    // **时钟冻住再对拍**:两条路各自取一次 `Date.now()`(手记账户的日网格右端就是它),
    // 不冻的话末点会差几毫秒,而那种差别会把「算法是不是同一个」这件事淹掉。
    it("长窗 all → sampled 且行数与历史长度脱钩", async () => {
      const acc = await seedAccount(USER, "甲", "bitcoin");
      const start = NOW - 120 * DAY;
      for (let i = 0; i < 120; i++) {
        await seedSnapshot(USER, acc.id, start + i * DAY, [
          { tokenId: BTC, amount: 1, usdValue: 100 + Math.sin(i / 3) * 50 },
        ]);
      }

      const raw = await call(USER, handleGetPortfolioHistory({ range: "all" }));

      expect(raw.sampled).toBe(true);
      expect(raw.rows.length).toBeLessThanOrEqual(80);
      expect(raw.rows.length).toBeGreaterThan(10);
    }, 30_000);

    it("与老那条服务端算法对拍:同一份数据,曲线一个点都不差", async () => {
      const a = await seedAccount(USER, "甲", "bitcoin");
      const b = await seedAccount(USER, "乙", "binance");
      const gone = await seedAccount(USER, "封存的", "okx");
      await seedManualAccount(USER, "手记", { symbol: "BTC", unitPrice: 100, amount: 2 });
      await seedSnapshot(USER, a.id, ago(5 * DAY), [{ tokenId: BTC, amount: 1, usdValue: 100 }]);
      await seedSnapshot(USER, b.id, ago(4 * DAY), [{ tokenId: ETH, amount: 1, usdValue: 50 }]);
      await seedSnapshot(USER, gone.id, ago(4 * DAY), [{ tokenId: ETH, amount: 2, usdValue: 70 }]);
      await seedSnapshot(USER, a.id, ago(DAY), [{ tokenId: BTC, amount: 1, usdValue: 120 }]);
      // 封存之后**不止一个点**,这是刻意的:最右边那个点由实时总额顶替,它一个人证明不了
      // 截断有没有发生。中间这个点才是。
      await seedSnapshot(USER, a.id, ago(DAY / 2), [{ tokenId: BTC, amount: 1, usdValue: 130 }]);
      // **在两天前那一刻归档**,不是现在:归档截断只对「封存之后的点」起作用,而 `setArchived`
      // 写的是当下。真按当下归档的话这份夹具里一个点都轮不到它,截断那一段就是白测的
      // (第一版正是这样 —— 把归档时刻发不发给前端改坏,对拍照样绿)。
      vi.useFakeTimers({ now: ago(2 * DAY), toFake: ["Date"] });
      await db(USER).accounts.setArchived(gone.id, true);
      vi.useFakeTimers({ now: NOW, toFake: ["Date"] });

      const legacy = await call(USER, legacyPortfolioHistory({ range: "30d" }));
      const served = await curve();

      expect(served).toEqual(legacy.series);
      // 夹具没有绕过被测代码:真有一条像样的曲线,而且末点真的被实时总额顶替过
      // (它与倒数第二个点的冻结值不同 —— 相等的话这条断言什么都证明不了)。
      expect(served.length).toBeGreaterThan(2);
      expect(served.at(-1)?.total).not.toBe(served.at(-2)?.total);
      // 归档截断在这份夹具里真的发生了:把那个账户放出来重画一遍,**封存之后的每个点**
      // 正好多出它那 70,封存之前的点一个字不变。
      const sealedAt = ago(2 * DAY);
      await db(USER).accounts.setArchived(gone.id, false);
      const unsealed = await curve();
      expect(unsealed.map((p) => p.t)).toEqual(served.map((p) => p.t));
      expect(unsealed.filter((p) => p.t >= sealedAt).length).toBeGreaterThan(1);
      for (const [i, p] of unsealed.entries()) {
        expect(p.total).toBeCloseTo(served[i].total + (p.t >= sealedAt ? 70 : 0), 6);
      }
    });
  });
});

// FOL-38 之前服务端跑的那几行,原样搬进测试当参照物 —— 只有对拍那条用例用它。
// 生产代码里已经没有这条路了(所以它住在这儿,不是留一份 dead code 在 src 里)。
const legacyPortfolioHistory = (data: {
  portfolioId?: string;
  range?: "7d" | "30d" | "1y" | "all";
}) =>
  Effect.gen(function* () {
    const store = yield* Database;
    const { selectedId, defaultId } = yield* resolveScope(data.portfolioId);
    const [rows, allAccounts, snapshots, settings, memberships] = yield* Effect.all(
      [
        store.snapshots.listTotals(),
        store.accounts.list(),
        store.snapshots.latest(),
        store.settings.get(),
        store.portfolios.listMemberships(),
      ],
      { concurrency: 5 },
    );
    const memberSet = accountIdsInView(
      allAccounts.map((a) => a.id),
      memberships,
      selectedId,
      defaultId,
    );
    const memberAccounts = allAccounts.filter((a) => memberSet.has(a.id));
    const accounts = accountsInView(allAccounts, memberships, selectedId, defaultId);
    const now = Date.now();
    const manualIds = new Set(
      memberAccounts.filter((a) => isManual(a.connectorId)).map((a) => a.id),
    );
    const snapRows = rows.filter((r) => !manualIds.has(r.accountId) && memberSet.has(r.accountId));
    const manualRows = yield* loadManualHistoryRows(memberAccounts, now);
    const archivedAt = new Map(
      memberAccounts.flatMap((a) => (a.archivedAt == null ? [] : [[a.id, a.archivedAt] as const])),
    );
    const series = buildPortfolioHistory([...snapRows, ...manualRows], archivedAt);
    if (series.length === 0) return { series };

    const byAccount = new Map(snapshots.map((s) => [s.snapshot.accountId, s]));
    yield* injectManualSnapshots(accounts, byAccount);
    const enriched = yield* Effect.flatMap(Oracle, (o) =>
      o.tokens.enrich(overviewEnrichIds(accounts, byAccount)),
    );
    const liveTotals = deriveLiveAccountTotals(
      accounts,
      byAccount,
      enriched,
      settings.valuationMode,
    );
    let grand = 0;
    for (const v of liveTotals.values()) grand += v;
    series[series.length - 1] = { ...series[series.length - 1], total: grand };
    return { series };
  });
