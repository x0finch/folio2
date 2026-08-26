import { beforeEach, describe, expect, it } from "vitest";
import { handleListAccounts } from "@/lib/server/accounts/list";
import { handleListAccountHoldings } from "@/lib/server/portfolio/account-holdings";
import { handleGetAccountGain24h } from "@/lib/server/portfolio/gain";
import { handleListAccountTags } from "@/lib/server/tags/account-tags";
import { handleListTags } from "@/lib/server/tags/list";
import { db } from "../_kit/db";
import { fakeRegistry } from "../_kit/fakes";
import { blockOutbound } from "../_kit/outbound";
import { call, callWithRegistry } from "../_kit/run";
import { seedAccount, seedSnapshot } from "../_kit/seed";
import { freshUser, otherUser } from "../_kit/user";

// ADR 0047:**作用域在服务端定**。账户域这五个读取口都按当前组合收口 —— 以前它们整份下发,
// 账户页自己筛,于是别的组合的账户名、余额、盈亏、标签都在响应里。
//
// 为什么值得有一条横跨五个口的用例(而不是各自那份用例里各加一条):这五个口是**同一条规则的五个
// 落点**,而漏掉任何一个都不报错 —— 画面照旧对(客户端那时还在筛),只是数据仍然发出去了。
// 一次装场景、一次断言五处,新加第六个口时这里会立刻显出「它没在名单上」。
describe("portfolio/scope", () => {
  const USER = "h-pf-scope";

  // 默认组合 vs 另一个组合,各一个账户。默认那个再挂一个标签 —— 标签是 Portfolio 内概念(ADR 0034),
  // 所以它也该跟着收口。
  let DEFAULT_ID = "";
  let WATCH_ID = "";
  let MINE = "";
  let WATCHED = "";

  const listed = async (portfolioId?: string) => {
    const { registry } = await fakeRegistry();
    return callWithRegistry(USER, registry, handleListAccounts({ portfolioId }));
  };

  beforeEach(async () => {
    blockOutbound();
    await freshUser(USER);
    await freshUser(otherUser(USER));
    const def = await db(USER).portfolios.ensureDefault();
    const watch = await db(USER).portfolios.create({ name: "Watch" });
    DEFAULT_ID = def.id;
    WATCH_ID = watch.id;
    const mine = await seedAccount(USER, "自己的", "bitcoin");
    const watched = await seedAccount(USER, "只看看", "binance");
    MINE = mine.id;
    WATCHED = watched.id;
    await db(USER).portfolios.assignAccount(MINE, DEFAULT_ID);
    await db(USER).portfolios.assignAccount(WATCHED, WATCH_ID);
    const now = Date.now();
    await seedSnapshot(USER, MINE, now, [{ tokenId: "bitcoin", amount: 1, usdValue: 100 }]);
    await seedSnapshot(USER, WATCHED, now, [{ tokenId: "ethereum", amount: 2, usdValue: 50 }]);
    const tag = await db(USER).tags.create({ portfolioId: DEFAULT_ID, name: "长期" });
    await db(USER).tags.attach(MINE, tag.id);
    await db(USER).tags.create({ portfolioId: WATCH_ID, name: "观察中" });
  });

  describe("账户域按当前组合收口", () => {
    it("账户列表只回这个组合的账户,并带上它的归属", async () => {
      expect((await listed(WATCH_ID)).map((a) => a.label)).toEqual(["只看看"]);
      expect((await listed(WATCH_ID))[0].portfolioId).toBe(WATCH_ID);
      expect((await listed(DEFAULT_ID)).map((a) => a.label)).toEqual(["自己的"]);
    });

    it("不带组合参数 = 默认组合", async () => {
      expect((await listed()).map((a) => a.label)).toEqual(["自己的"]);
    });

    it("按账户的持仓与 24h 盈亏一样只回这个组合的", async () => {
      const holdings = await call(USER, handleListAccountHoldings({ portfolioId: WATCH_ID }));
      expect(holdings.rows.map((r) => r.account.label)).toEqual(["只看看"]);

      const gain = await call(USER, handleGetAccountGain24h({ portfolioId: WATCH_ID }));
      expect(Object.keys(gain.accounts)).toEqual([WATCHED]);
    });

    it("标签定义与账户→标签关联也跟着收口", async () => {
      expect(
        (await call(USER, handleListTags({ portfolioId: WATCH_ID }))).map((t) => t.name),
      ).toEqual(["观察中"]);
      // 唯一那条关联挂在默认组合的账户上 → 看 Watch 时一条都不该回。
      expect(await call(USER, handleListAccountTags({ portfolioId: WATCH_ID }))).toEqual([]);
      expect(
        (await call(USER, handleListAccountTags({ portfolioId: DEFAULT_ID }))).map(
          (l) => l.accountId,
        ),
      ).toEqual([MINE]);
    });

    it("**归档账户仍在里面** —— 账户页有归档区,收口用的是「归档无关」那个口径", async () => {
      await db(USER).accounts.setArchived(WATCHED, true);

      expect((await listed(WATCH_ID)).map((a) => a.label)).toEqual(["只看看"]);
      const holdings = await call(USER, handleListAccountHoldings({ portfolioId: WATCH_ID }));
      expect(holdings.rows.map((r) => r.account.label)).toEqual(["只看看"]);
    });

    it("认不出的组合 id(别人的 / 已删的)→ 静默落回默认,不是空视图", async () => {
      const theirs = await db(otherUser(USER)).portfolios.ensureDefault();

      expect((await listed(theirs.id)).map((a) => a.label)).toEqual(["自己的"]);
      expect((await listed("pf-does-not-exist")).map((a) => a.label)).toEqual(["自己的"]);
    });
  });
});
