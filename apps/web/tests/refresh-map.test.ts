import { QueryClient } from "@tanstack/react-query";
import { beforeEach, describe, expect, it } from "vitest";
import {
  accountKeys,
  portfolioKeys,
  preferenceKeys,
  settingsKeys,
  syncKeys,
  tagKeys,
  tokenKeys,
} from "@/lib/queries/keys";

import { invalidateFor, REFRESH_MAP } from "@/lib/queries/refresh";

// 摘要按 Portfolio 一份(ADR 0033),key 上带着它;刷新映射盖的是域前缀,与具体是哪个无关。
const PF = "pf-1";

// 刷新映射表的钉子。**这里钉的不是「表里写了什么」**(那是把代码抄一遍),而是
// 「表里那条前缀,真的能匹配上各查询实际在用的 key 吗」—— 定向刷新唯一会静默失败的地方。
// 前缀写错一个字(`["sync"]` 写成 `["syncs"]`),运行时不报错,只表现为「同步完了面板不动」。

// 真的 QueryClient,不是 mock:匹配规则(前缀匹配、部分匹配)是 react-query 的行为,
// mock 掉就等于把要验的东西自己实现了一遍。
let queryClient: QueryClient;

// 往缓存里塞一条已成功的查询 —— invalidateQueries 的作用是把它标记为「旧」。
const seed = (queryKey: readonly unknown[]) =>
  queryClient.setQueryData([...queryKey], { seeded: true });

const isInvalidated = (queryKey: readonly unknown[]) =>
  queryClient.getQueryState([...queryKey])?.isInvalidated === true;

describe("刷新映射表", () => {
  beforeEach(() => {
    queryClient = new QueryClient();
  });

  it("sync.round 刷到同步状态,不误伤别的域", async () => {
    seed(syncKeys.status(PF));
    // 一轮同步不改估值口径 —— 误伤的代价是白打一趟服务器。
    seed(settingsKeys.valuation());

    await invalidateFor(queryClient, "sync.round");

    expect(isInvalidated(syncKeys.status(PF))).toBe(true);
    expect(isInvalidated(settingsKeys.valuation())).toBe(false);
  });

  // 既有 bug 的钉子(#411):整页刷新只重跑 loader,而 loader 只预取默认组合那一份 ——
  // 停在非默认组合、或停在自定义 Tab 上时,同步跑完画面不动。前缀刷新必须把三种视图一起盖住。
  it("sync.round 盖住默认 / 非默认 / 自定义 Tab 三种总览视图", async () => {
    const def = portfolioKeys.overview("pf-default");
    const other = portfolioKeys.overview("pf-other");
    const pinned = portfolioKeys.overview("pf-other", { kind: "tag", tagId: "tg1" });
    for (const k of [def, other, pinned]) seed(k);

    await invalidateFor(queryClient, "sync.round");

    expect([isInvalidated(def), isInvalidated(other), isInvalidated(pinned)]).toEqual([
      true,
      true,
      true,
    ]);
  });

  // FOL-51:24h 盈亏改成随总览原料(`portfolioKeys.overview`)/ 持仓(`accountKeys.holdings`)
  // 一起回,不再有独立的 gain24h 键。所以「盈亏被盖住」这件事由那两个键的失效自然保证,
  // 无需单独钉一条 —— 下面几条已经盖了 overview / holdings。

  // 跨域那条:加一个账户不只是账户列表多一行,首页总额 / 走势 / 按代币的聚合全跟着变。
  // 只刷账户域会让总览停在旧数字,而且不报错 —— 所以这条单独钉住。
  it("account.write 同时刷账户域与组合域", async () => {
    seed(accountKeys.list("pf-1"));
    seed(accountKeys.holdings("pf-1"));
    seed(accountKeys.manualDetail("a1"));
    seed(portfolioKeys.overview("pf-1"));

    await invalidateFor(queryClient, "account.write");

    expect(
      [
        accountKeys.list("pf-1"),
        accountKeys.holdings("pf-1"),
        accountKeys.manualDetail("a1"),
        portfolioKeys.overview("pf-1"),
      ].map(isInvalidated),
    ).toEqual([true, true, true, true]);
  });

  it("sync.round 也刷账户域(账户行的市值与上次同步跟着变)", async () => {
    seed(accountKeys.holdings("pf-1"));
    await invalidateFor(queryClient, "sync.round");
    expect(isInvalidated(accountKeys.holdings("pf-1"))).toBe(true);
  });

  // review 抓到的漏刷之一。同步摘要是**按账户集算出来的**(`summarizeSync`):页头面板的 N/M、
  // 「未同步」清单、以及「立即同步」到底同步哪些账户,全都来自它。归档 / 删除 / 改名一个账户
  // 之后不刷同步域,面板就停在旧数字,而「立即同步」还会带着已删掉的账户跑 —— 且不报错。
  it("account.write 刷同步域(否则页头面板与「立即同步」的账户集停在旧值)", async () => {
    seed(syncKeys.status(PF));
    await invalidateFor(queryClient, "account.write");
    expect(isInvalidated(syncKeys.status(PF))).toBe(true);
  });

  // 同一批漏刷的另一处:`dataStats.hasData` 就是「账户数 > 0」,而它决定导入前弹不弹确认框。
  // 空库时进过设置页 → 去加账户 → 回设置页导入,不刷这条就会**跳过那道确认**。
  it("account.write 刷 dataStats,但不碰估值口径与 provider key", async () => {
    seed(settingsKeys.dataStats());
    seed(settingsKeys.valuation());
    seed(settingsKeys.providerKeys());

    await invalidateFor(queryClient, "account.write");

    expect(isInvalidated(settingsKeys.dataStats())).toBe(true);
    // 窄口径:账户增删与估值口径 / provider key 无关,别顺手把整个设置域拉一遍。
    expect(isInvalidated(settingsKeys.valuation())).toBe(false);
    expect(isInvalidated(settingsKeys.providerKeys())).toBe(false);
  });

  // FOL-56:首页 tag pin 内容在浏览器按 `accountTagLinks` 收窄,不必 invalidate 快照键。
  it("tag.write 只刷标签域,不碰快照/总览键", async () => {
    seed(tagKeys.list("pf-1"));
    seed(tagKeys.accountLinks("pf-1"));
    seed(portfolioKeys.snapshots("pf-1", 1_700_000_000_000));
    seed(portfolioKeys.overview("pf-1", { kind: "tag", tagId: "t1" }));

    await invalidateFor(queryClient, "tag.write");

    expect([tagKeys.list("pf-1"), tagKeys.accountLinks("pf-1")].map(isInvalidated)).toEqual([
      true,
      true,
    ]);
    expect(isInvalidated(portfolioKeys.snapshots("pf-1", 1_700_000_000_000))).toBe(false);
    expect(isInvalidated(portfolioKeys.overview("pf-1", { kind: "tag", tagId: "t1" }))).toBe(false);
  });

  // review 抓到的漏刷之二:Tag 归属 Portfolio,所以组合域的写会**连带删掉标签关联** ——
  // 移动账户时显式删 accountTags,删组合时 tags 经 cascade 清。只刷组合域会让账户行的徽标
  // 和抽屉里的标签选择器继续显示服务端已经删掉的标签(幽灵标签),而且不报错。
  it("portfolio.write 连标签域一起刷(移动账户 / 删组合会删掉标签关联)", async () => {
    seed(tagKeys.list("pf-1"));
    seed(tagKeys.accountLinks("pf-1"));

    await invalidateFor(queryClient, "portfolio.write");

    expect([tagKeys.list("pf-1"), tagKeys.accountLinks("pf-1")].map(isInvalidated)).toEqual([
      true,
      true,
    ]);
  });

  // ADR 0047 之后新欠的账(review 抓的):账户页那几份是服务端按组合筛好的,移动账户 / 删组合
  // 直接改了「哪个组合里有哪些账户」。改造前靠「刷组合域 → 归属表变 → 客户端重筛」兜着,
  // 归属表不下发之后那条路没有了 —— 不刷账户域,被移走的账户还留在旧组合的列表里。
  // 页头同步摘要(它按组合收口更早)同理。
  it("portfolio.write 连账户域与同步域一起刷(移动账户改的是名单本身)", async () => {
    seed(accountKeys.list("pf-1"));
    seed(accountKeys.holdings("pf-1"));
    seed(syncKeys.status("pf-1"));

    await invalidateFor(queryClient, "portfolio.write");

    expect(
      [accountKeys.list("pf-1"), accountKeys.holdings("pf-1"), syncKeys.status("pf-1")].map(
        isInvalidated,
      ),
    ).toEqual([true, true, true]);
  });

  it("portfolio.write 刷整个组合域(清单、tab 条、总览一起)", async () => {
    const keys = [
      portfolioKeys.list(),
      portfolioKeys.tabPins("pf-1"),
      portfolioKeys.overview("pf-1"),
      portfolioKeys.history("pf-1", "30d"),
    ];
    for (const k of keys) seed(k);

    await invalidateFor(queryClient, "portfolio.write");

    expect(keys.map(isInvalidated)).toEqual([true, true, true, true]);
  });

  // 刻意的窄口径:增删一个自定义 Tab 不改任何余额,把昂贵的总览连带拉一遍是白花钱。
  // 这条钉住那个决定 —— 有人把它并进 `portfolio.write` 时会红。
  it("portfolio.pin.write 只刷 tab 条,不碰总览", async () => {
    seed(portfolioKeys.tabPins("pf-1"));
    seed(portfolioKeys.overview("pf-1"));

    await invalidateFor(queryClient, "portfolio.pin.write");

    expect(isInvalidated(portfolioKeys.tabPins("pf-1"))).toBe(true);
    expect(isInvalidated(portfolioKeys.overview("pf-1"))).toBe(false);
  });

  // 这一条是整张表里唯一的**跨域推断**:法币选项的名字由服务端按请求 locale 本地化,
  // 所以切语言必须连代币域一起刷,否则切完那几行还是旧语种。此前没有测试钉住它。
  it("preference.locale 连法币选项一起刷,但不碰组合域", async () => {
    seed(preferenceKeys.locale());
    seed(tokenKeys.fiatOptions());
    seed(portfolioKeys.overview("pf-1"));

    await invalidateFor(queryClient, "preference.locale");

    expect([preferenceKeys.locale(), tokenKeys.fiatOptions()].map(isInvalidated)).toEqual([
      true,
      true,
    ]);
    // 总览是 USD 计价的,和界面语言无关。
    expect(isInvalidated(portfolioKeys.overview("pf-1"))).toBe(false);
  });

  // 展示币种只换汇率与格式 —— 总览数据本身是 USD 计价的,别顺手把它拉一遍。
  it("preference.currency 只刷币种偏好", async () => {
    seed(preferenceKeys.currency());
    seed(portfolioKeys.overview("pf-1"));

    await invalidateFor(queryClient, "preference.currency");

    expect(isInvalidated(preferenceKeys.currency())).toBe(true);
    expect(isInvalidated(portfolioKeys.overview("pf-1"))).toBe(false);
  });

  // 估值口径是**读时重估**:历史不重算,但现值全部按新口径重来。同步状态与它无关。
  it("settings.valuation 刷总览与账户持仓,不碰同步域", async () => {
    seed(settingsKeys.valuation());
    seed(portfolioKeys.overview("pf-1"));
    seed(accountKeys.holdings("pf-1"));
    seed(syncKeys.status(PF));

    await invalidateFor(queryClient, "settings.valuation");

    expect(
      [settingsKeys.valuation(), portfolioKeys.overview("pf-1"), accountKeys.holdings("pf-1")].map(
        isInvalidated,
      ),
    ).toEqual([true, true, true]);
    expect(isInvalidated(syncKeys.status(PF))).toBe(false);
  });

  // 导入是唯一一条「什么都可能变」的写 —— 五个域一个都不能少,省一个就是一处「导完了那块不动」。
  it("settings.data 刷全部五个域", async () => {
    const keys = [
      settingsKeys.dataStats(),
      syncKeys.status(PF),
      portfolioKeys.overview("pf-1"),
      accountKeys.list("pf-1"),
      tagKeys.list("pf-1"),
    ];
    for (const k of keys) seed(k);

    await invalidateFor(queryClient, "settings.data");

    expect(keys.map(isInvalidated)).toEqual([true, true, true, true, true]);
  });

  // 后台刷价只改金额,不改口径、不产生新快照 —— 所以不碰设置域与同步域。
  it("prices.refreshed 只刷组合域与账户域", async () => {
    seed(portfolioKeys.overview("pf-1"));
    seed(accountKeys.holdings("pf-1"));
    seed(syncKeys.status(PF));
    seed(settingsKeys.valuation());

    await invalidateFor(queryClient, "prices.refreshed");

    expect(
      [portfolioKeys.overview("pf-1"), accountKeys.holdings("pf-1")].map(isInvalidated),
    ).toEqual([true, true]);
    expect([syncKeys.status(PF), settingsKeys.valuation()].map(isInvalidated)).toEqual([
      false,
      false,
    ]);
  });

  // 结构性的一条:表里每条前缀都得是**某个域前缀**下的东西,而不是随手写的字符串数组。
  // 域前缀集合随各片迁移增长,这条会跟着自动覆盖新加的条目。
  it("表里每条前缀都落在已知的域前缀上", () => {
    const domains: readonly (readonly string[])[] = [
      syncKeys.all,
      portfolioKeys.all,
      accountKeys.all,
      tagKeys.all,
      settingsKeys.all,
      preferenceKeys.all,
      tokenKeys.all,
    ];
    for (const [event, prefixes] of Object.entries(REFRESH_MAP)) {
      expect(prefixes.length, `${event} 至少要刷一个前缀`).toBeGreaterThan(0);
      for (const prefix of prefixes) {
        const matched = domains.some((d) => d.every((seg, i) => prefix[i] === seg));
        expect(matched, `${event} 的前缀 ${JSON.stringify(prefix)} 不属于任何已知域`).toBe(true);
      }
    }
  });
});
