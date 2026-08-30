import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// #493 票 2:名单先出、金额后到。骨架跟真内容漂了,没有运行时报错,
// 只有「数字出来的时候整页顿一下」或「回访先闪骨架」。

const ROOT = join(import.meta.dirname, "../src");

function src(rel: string): string {
  return readFileSync(join(ROOT, rel), "utf8");
}

function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

describe("骨架与真内容同形", () => {
  it("名单骨架贴合真实行的 padding", () => {
    const page = src("routes/_authed/-accounts/index.tsx");
    expect(page).toContain("px-3 py-3");
    expect(page).toMatch(/function ListSkeleton[\s\S]*px-3 py-3/);
  });

  it("金额没到时走骨架,不是 0,也不是破折号", () => {
    const page = stripComments(src("routes/_authed/-accounts/index.tsx"));
    expect(page).toContain("!row.valuesReady");
    expect(page).not.toMatch(/valuesReady[\s\S]{0,80}usd\(0\)/);
  });
});

describe("回访不闪骨架、金额失败继续骨架", () => {
  // 机制换过一次:后到的那三样(余额 / 盈亏 / 标签)原来是 `useQuery` + `isPending`,
  // 现在是挂起 + `QueryBoundary`。换的理由是 SSR —— 服务端渲染那一遍它们往往已经回来了,
  // 而客户端补水那一帧没有,两边画的不是同一份 HTML,React 把整棵子树丢掉重渲。
  //
  // **要钉的性质一条没变**,下面几条就是那些性质:名单先出、金额后到、回访不闪骨架、
  // 金额失败不写「拉取失败」。
  it("回访不闪骨架:后到的两样走挂起,没人退回去看 isFetching", () => {
    const page = stripComments(src("routes/_authed/-accounts/index.tsx"));
    // `useSuspenseQuery` 命中缓存时直接给旧值、后台刷新、**不挂起** —— 回访不会再出骨架。
    // 会破坏这条的写法是回去看 `isFetching`(那会把后台刷新也画成骨架)。
    expect(page).not.toContain("isFetching");
    // FOL-51:后到的是余额(含 24h 盈亏,两端相减随持仓回)与标签,不再有独立的盈亏查询。
    expect(page).toMatch(/useSuspenseQuery\(accountHoldingsQuery/);
    expect(page).not.toContain("accountGain24hQuery");
  });

  // 「先画出别的组合的账户」这件事**现在压根不可能**(ADR 0047):名单是服务端按组合筛好的那一份,
  // 客户端手里没有别的组合的账户可画。原来这条钉的是「名单要等归属那份数据一起到」—— 归属不再是
  // 独立一份数据了,所以改钉:名单按**组合**取,而且是外层那个挂起点。
  it("名单按当前组合取,且仍是外层挂起(不会先画一份再改)", () => {
    const page = stripComments(src("routes/_authed/-accounts/index.tsx"));
    expect(page).toMatch(/useSuspenseQuery\(accountListQuery\(selectedId\)\)/);
    // 客户端不再有「拿全量 + 按归属筛」这条路。
    expect(page).not.toContain("portfolioMembershipsQuery");
    expect(page).not.toContain("accountIdsInView");
  });

  // 标签不该挡住**名单**。它现在也走挂起,但挂在**里层**那个边界上 —— 而里层的兜底
  // (`pending`)渲的是同一个 `AccountsListBody`,账户名与徽章照旧在里头。所以名单不等标签。
  it("标签不挡名单:挂起点在里层,兜底仍然是那份名单", () => {
    const page = stripComments(src("routes/_authed/-accounts/index.tsx"));
    // 名单本身仍然是外层的挂起 —— 变成非挂起就会先画一份不完整的名单。
    expect(page).toMatch(/useSuspenseQuery\(accountListQuery/);
    // 标签在里层那个边界之后取。
    expect(page).toMatch(/AccountsListReady[\s\S]*useSuspenseQuery\(tagListQuery/);
    // 里层的兜底不是整块骨架,是同一份名单。
    expect(page).toMatch(/pending=\{[\s\S]{0,200}<AccountsListBody/);
    expect(page).toMatch(/allTags = \[\]/);
  });

  // 金额那三样拉失败,**不该把名单换成「拉取失败」** —— 名单本身是好的。
  // 所以里层边界的 `failed` 也是同一个 body(带 gainFailed),不是 `ListFailed`。
  it("金额失败不写拉取失败,名单照旧", () => {
    const page = stripComments(src("routes/_authed/-accounts/index.tsx"));
    expect(page).toMatch(/failed=\{[\s\S]{0,200}<AccountsListBody/);
    expect(page).not.toMatch(/failed=\{<ListFailed[\s\S]{0,200}<AccountsListReady/);
    // 外层那个边界(名单本身塌了)仍然用 ListFailed —— 那才是该显示失败句的一层。
    expect(page).toMatch(/failed=\{<ListFailed \/>\}/);
  });

  it("增量直接取自行上的 gain24h(随持仓一起回,FOL-51)", () => {
    const page = stripComments(src("routes/_authed/-accounts/index.tsx"));
    // 盈亏不再是后到的一包、按 flag 决定占位 —— 它就在 `AccountRow.gain24h` 上,行组件直接读。
    expect(page).not.toContain("gainPending");
    expect(page).not.toContain("gainFailed");
    expect(page).toMatch(/dayChange\?\.amount/);
  });

  // **别用「补水完成了没」这种开关去躲骨架。** 那样两边确实一致了,代价是服务端也只渲骨架 ——
  // SSR 出去的 HTML 里那些数字就没了,JS 跑起来之前谁都看不到。真要一致,该让两边挂在同一个
  // 挂起点上(现在的做法),不是把服务端那半也蒙掉。**试过一次,就是因为这条被挡回来的。**
  it("没有自造 hydration 开关来躲骨架", () => {
    const page = src("routes/_authed/-accounts/index.tsx");
    expect(page).not.toMatch(/useHydrated|use-hydrated|isHydrated/);
  });
});
