import { QueryClient } from "@tanstack/react-query";
import { beforeEach, describe, expect, it } from "vitest";
import { accountKeys, portfolioKeys, syncKeys, tagKeys } from "../src/lib/queries/keys";
import { invalidateFor, REFRESH_MAP } from "../src/lib/queries/refresh";

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
    seed(syncKeys.status());
    // 还没迁的域(仍走整页刷新)不该被这条语义碰到 —— 误伤的代价是白打一趟服务器。
    const untouched = ["settings", "valuation"] as const;
    seed(untouched);

    await invalidateFor(queryClient, "sync.round");

    expect(isInvalidated(syncKeys.status())).toBe(true);
    expect(isInvalidated(untouched)).toBe(false);
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

  // 跨域那条:加一个账户不只是账户列表多一行,首页总额 / 走势 / 按代币的聚合全跟着变。
  // 只刷账户域会让总览停在旧数字,而且不报错 —— 所以这条单独钉住。
  it("account.write 同时刷账户域与组合域", async () => {
    seed(accountKeys.list());
    seed(accountKeys.holdings());
    seed(accountKeys.manualDetail("a1"));
    seed(portfolioKeys.overview("pf-1"));

    await invalidateFor(queryClient, "account.write");

    expect(
      [
        accountKeys.list(),
        accountKeys.holdings(),
        accountKeys.manualDetail("a1"),
        portfolioKeys.overview("pf-1"),
      ].map(isInvalidated),
    ).toEqual([true, true, true, true]);
  });

  it("sync.round 也刷账户域(账户行的市值与上次同步跟着变)", async () => {
    seed(accountKeys.holdings());
    await invalidateFor(queryClient, "sync.round");
    expect(isInvalidated(accountKeys.holdings())).toBe(true);
  });

  // 按标签固定的自定义 Tab 是靠标签关联收窄的 —— 摘一个标签,那个 Tab 里就该少一个账户的持仓。
  it("tag.write 同时刷标签域与组合域", async () => {
    seed(tagKeys.list());
    seed(tagKeys.accountLinks());
    seed(portfolioKeys.overview("pf-1", { kind: "tag", tagId: "t1" }));

    await invalidateFor(queryClient, "tag.write");

    expect(
      [
        tagKeys.list(),
        tagKeys.accountLinks(),
        portfolioKeys.overview("pf-1", { kind: "tag", tagId: "t1" }),
      ].map(isInvalidated),
    ).toEqual([true, true, true]);
  });

  it("portfolio.write 刷整个组合域(清单、归属、总览一起)", async () => {
    const keys = [
      portfolioKeys.list(),
      portfolioKeys.memberships(),
      portfolioKeys.overview("pf-1"),
      portfolioKeys.history("pf-1"),
    ];
    for (const k of keys) seed(k);

    await invalidateFor(queryClient, "portfolio.write");

    expect(keys.map(isInvalidated)).toEqual([true, true, true, true]);
  });

  // 刻意的窄口径:增删一个自定义 Tab 不改任何余额,把昂贵的总览连带拉一遍是白花钱。
  // 这条钉住那个决定 —— 有人把它并进 `portfolio.write` 时会红。
  it("portfolio.pin.write 只刷 Tab 清单,不碰总览", async () => {
    seed(portfolioKeys.pins());
    seed(portfolioKeys.overview("pf-1"));

    await invalidateFor(queryClient, "portfolio.pin.write");

    expect(isInvalidated(portfolioKeys.pins())).toBe(true);
    expect(isInvalidated(portfolioKeys.overview("pf-1"))).toBe(false);
  });

  // **过渡期最要命的一条。** 一个域的读一旦搬进 `ensureQueryData`,整页 `router.invalidate()`
  // 就再也刷不动它(缓存里有数据就原样返回,不看 stale)。所以只要还有写路径没迁,
  // `legacy.whole-page` 就必须罩住**每一个已迁的域** —— 漏一个的表现是「改了东西画面不变」,
  // 不报错。这条最初就是被漏掉的:账户的读迁完、写还没迁那一片,加账户之后账户行不出现,
  // 由 e2e 抓出来。
  it("legacy.whole-page 罩住映射表里出现过的每一个域", () => {
    const mentioned = new Set(
      Object.entries(REFRESH_MAP)
        .filter(([event]) => event !== "legacy.whole-page")
        .flatMap(([, prefixes]) => prefixes.map((p) => String(p[0]))),
    );
    const covered = new Set(REFRESH_MAP["legacy.whole-page"].map((p) => String(p[0])));
    for (const domain of mentioned) {
      expect(covered.has(domain), `已迁的域 "${domain}" 不在 legacy.whole-page 里`).toBe(true);
    }
  });

  // 结构性的一条:表里每条前缀都得是**某个域前缀**下的东西,而不是随手写的字符串数组。
  // 域前缀集合随各片迁移增长,这条会跟着自动覆盖新加的条目。
  it("表里每条前缀都落在已知的域前缀上", () => {
    const domains: readonly (readonly string[])[] = [
      syncKeys.all,
      portfolioKeys.all,
      accountKeys.all,
      tagKeys.all,
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
