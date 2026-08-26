import { describe, expect, it } from "vitest";
import { pickSelectedPortfolio, portfolioSwitchSearch } from "@/lib/hooks/use-portfolio";

// 选中的 Portfolio 进 URL(ADR 0046)。八条决定里有六条能在这一层断言:
// 默认不写、非默认写、未知 id 回默认、别人的 id 回默认、旧参数被丢干净、组合参数自身留下。

const DEFAULT = "pf-default";
const WATCH = "pf-watch";
const LIST = [{ id: DEFAULT }, { id: WATCH }];

describe("pickSelectedPortfolio", () => {
  it("地址里写着谁就选谁", () => {
    expect(pickSelectedPortfolio(WATCH, LIST, DEFAULT)).toBe(WATCH);
  });

  it("没带这个参数 → 默认那个", () => {
    expect(pickSelectedPortfolio(undefined, LIST, DEFAULT)).toBe(DEFAULT);
  });

  it("认不出的 id → 安静回默认(过期的收藏链接不该给空视图)", () => {
    expect(pickSelectedPortfolio("pf-deleted", LIST, DEFAULT)).toBe(DEFAULT);
  });

  it("别人的 id 与不存在的 id **完全同一个结果**(越权探测无回应差异)", () => {
    const someoneElses = pickSelectedPortfolio("pf-of-another-user", LIST, DEFAULT);
    const neverExisted = pickSelectedPortfolio("pf-never-existed", LIST, DEFAULT);
    expect(someoneElses).toBe(neverExisted);
    expect(someoneElses).toBe(DEFAULT);
  });

  // 这几种进不来 route 的校验器(那边 `.catch(undefined)` 兜住了),但 `_authed` 的 loader 读的是
  // 原始解析结果 —— 手改地址栏就能造出来。
  it("形状本身不对(空串 / 重复参数 / 数字)→ 当没带", () => {
    expect(pickSelectedPortfolio("", LIST, DEFAULT)).toBe(DEFAULT);
    expect(pickSelectedPortfolio([WATCH, DEFAULT], LIST, DEFAULT)).toBe(DEFAULT);
    expect(pickSelectedPortfolio(123, LIST, DEFAULT)).toBe(DEFAULT);
    expect(pickSelectedPortfolio(null, LIST, DEFAULT)).toBe(DEFAULT);
  });
});

describe("portfolioSwitchSearch", () => {
  it("非默认组合写进地址", () => {
    expect(portfolioSwitchSearch(WATCH, DEFAULT)).toEqual({ portfolio: WATCH });
  });

  it("默认组合不写进地址(值是 undefined,键仍在)", () => {
    const next = portfolioSwitchSearch(DEFAULT, DEFAULT);
    expect(next.portfolio).toBeUndefined();
    // 键必须在:`retainSearchParams` 只在「新 search 里没有这个键」时补旧值,键不写参数就消不掉。
    expect("portfolio" in next).toBe(true);
  });

  it("旧组合里的那些参数一个都不带(整份新的,不是改一个键)", () => {
    // 断言键集合而不是逐个 `toBeUndefined`:这条规则的要点是「只有这一个键」——
    // 将来新增一个页内参数,忘了它也不会漏进来。
    expect(Object.keys(portfolioSwitchSearch(WATCH, DEFAULT))).toEqual(["portfolio"]);
  });
});
