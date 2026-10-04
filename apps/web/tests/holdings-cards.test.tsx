import type { Note } from "@folio/connectors-basic";
import { fireEvent, render } from "@testing-library/react";
import { IntlProvider } from "use-intl";
import { describe, expect, it } from "vitest";
import { AccountHoldingsCards } from "@/components/holdings-cards";
import type { OverviewBalance } from "@/lib/core/account-view";
import { messages } from "@/lib/i18n/messages";

// 账户详情抽屉的持仓卡片列表。钉住「给这些余额 → 屏幕上出哪些分区、每区出哪些行」:
// ① 空态分两种说法:真没快照 vs. 有余额但全是尘埃(后者以前漏成空白面板);
// ② 现货按 note.group 拆钱包(funding / earn 各成一区,ADR 0030),其余归现货;
// ③ 只有一个分区 → 直接渲染,不出孤零零一个 tab;≥2 → tab 切换;
// ④ 永续区要过门槛:有持仓、或权益 ≥ $1,零持仓的 dust 权益不占 tab;
// ⑤ 现货行按美元值降序,名字缺省时用大写代号;account 级 note 在顶部手风琴里。
const to = messages.en.Overview;

let seq = 0;
const spot = (symbol: string, usdValue: number, extra: Partial<OverviewBalance> = {}) =>
  ({
    id: `b${seq++}`,
    symbol,
    amount: 1,
    usdValue,
    kind: "spot",
    metaJson: null,
    ...extra,
  }) as OverviewBalance;
const wallet = (group: string): Note => ({ title: group, content: "", group });
const perpEquity = (accountValue: number) =>
  ({
    id: `b${seq++}`,
    amount: 0,
    usdValue: accountValue,
    kind: "perp_equity",
    metaJson: JSON.stringify({ withdrawable: 0, totalMarginUsed: 0, totalNtlPos: 0 }),
  }) as OverviewBalance;
const defi = (protocol: string, symbol: string, usdValue: number) =>
  ({
    id: `b${seq++}`,
    symbol,
    amount: 1,
    usdValue,
    kind: "defi",
    metaJson: JSON.stringify({ protocol }),
  }) as OverviewBalance;

function mount(balances: OverviewBalance[], accountNote?: Note[]) {
  const utils = render(
    <IntlProvider locale="en" messages={messages.en} timeZone="UTC">
      <AccountHoldingsCards balances={balances} accountNote={accountNote} />
    </IntlProvider>,
  );
  const tabs = () =>
    [...utils.container.querySelectorAll('[role="tab"]')].map((t) => t.textContent?.trim());
  const tab = (label: string) =>
    [...utils.container.querySelectorAll('[role="tab"]')].find(
      (t) => t.textContent?.trim() === label,
    ) as HTMLElement;
  // 当前可见的文字(未激活的 tab 面板是 `hidden` 挂着的,不算)。
  const visibleText = () => {
    const clone = utils.container.cloneNode(true) as HTMLElement;
    for (const h of clone.querySelectorAll("[hidden]")) h.remove();
    return clone.textContent ?? "";
  };
  return { ...utils, tabs, tab, visibleText };
}

describe("AccountHoldingsCards — 空态", () => {
  it("没有任何余额 → 「还没有快照」", () => {
    const { container } = mount([]);
    expect(container.textContent).toBe(to.noSnapshot);
  });

  it("有余额但全是尘埃 → 「只有零值持仓」(不是空白)", () => {
    const { container } = mount([spot("dust", 0.01)]);
    expect(container.textContent).toBe(to.onlyDustHoldings);
  });

  it("没有可展示持仓但有 account 级 note → 渲染 note,不显示空态", () => {
    const note: Note = { title: "Unconfirmed", content: "1 pending tx", icon: "warning" };
    const { container } = mount([], [note]);
    expect(container.textContent).toContain("Unconfirmed");
    expect(container.textContent).not.toContain(to.noSnapshot);
  });
});

describe("AccountHoldingsCards — 分区", () => {
  it("只有现货 → 直接渲染行,不出 tab;按美元值降序;缺名用大写代号", () => {
    const { tabs, container } = mount([
      spot("eth", 100, { name: "Ethereum" }),
      spot("btc", 500, { name: "Bitcoin" }),
      spot("pepe", 5),
    ]);
    expect(tabs()).toEqual([]);
    const text = container.textContent ?? "";
    expect(text.indexOf("Bitcoin")).toBeLessThan(text.indexOf("Ethereum"));
    expect(text.indexOf("Ethereum")).toBeLessThan(text.indexOf("PEPE"));
    expect(text).not.toContain("pepe"); // 名字位用的是大写代号,不是原样的小写
  });

  it("现货按 note.group 拆成 现货 / 资金 / 理财 三个 tab,各区只放自己的币", () => {
    const { tabs, tab, visibleText } = mount([
      spot("btc", 500, { name: "Bitcoin" }),
      spot("usdt", 300, { name: "Tether", note: wallet("funding") }),
      spot("sol", 200, { name: "Solana", note: wallet("earn") }),
    ]);
    expect(tabs()).toEqual([to.tokensTab, to.fundingTab, to.earnTab]);

    // 默认第一个 tab:只看得到现货。
    expect(visibleText()).toContain("Bitcoin");
    expect(visibleText()).not.toContain("Tether");

    fireEvent.click(tab(to.fundingTab));
    expect(visibleText()).toContain("Tether");
    expect(visibleText()).not.toContain("Bitcoin");

    fireEvent.click(tab(to.earnTab));
    expect(visibleText()).toContain("Solana");
    expect(visibleText()).not.toContain("Tether");
  });

  it("永续:零持仓且权益 < $1 不出 tab;权益 ≥ $1 出 tab", () => {
    expect(mount([spot("btc", 500), perpEquity(0.5)]).tabs()).toEqual([]);
    expect(mount([spot("btc", 500), perpEquity(25)]).tabs()).toEqual([to.tokensTab, to.perpsTab]);
  });

  it("DeFi 头寸自成一区", () => {
    const { tabs, tab, visibleText } = mount([
      spot("btc", 500, { name: "Bitcoin" }),
      defi("Aave", "USDC", 1000),
    ]);
    expect(tabs()).toEqual([to.tokensTab, to.defiTab]);
    fireEvent.click(tab(to.defiTab));
    expect(visibleText()).toContain("Aave");
    expect(visibleText()).not.toContain("Bitcoin");
  });

  it("account 级 note 与持仓同时存在 → 顶部手风琴 + 持仓都在", () => {
    const note: Note = { title: "Receiving address", content: "bc1q…", icon: "info" };
    const { container } = mount([spot("btc", 500, { name: "Bitcoin" })], [note]);
    const text = container.textContent ?? "";
    expect(text).toContain("Receiving address");
    expect(text.indexOf("Receiving address")).toBeLessThan(text.indexOf("Bitcoin"));
  });
});
