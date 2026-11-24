import type { Note } from "@folio/connectors-basic";
import { fireEvent, render } from "@testing-library/react";
import { IntlProvider } from "use-intl";
import { describe, expect, it } from "vitest";
import { AccountHoldingsCards } from "@/components/holdings-cards";
import type { OverviewBalance } from "@/lib/core/account-view";
import { messages } from "@/lib/i18n/messages";
import { tabLabel } from "./helpers/tabs";

// Account sheet holdings cards: which sections and rows appear for given balances. Spot splits into
// wallets by note.group; a single section renders without tabs; perps need positions or equity ≥ $1.
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
  const tabs = () => [...utils.container.querySelectorAll('[role="tab"]')].map(tabLabel);
  const tab = (label: string) =>
    [...utils.container.querySelectorAll('[role="tab"]')].find(
      (t) => tabLabel(t) === label,
    ) as HTMLElement;
  // Currently visible text (inactive tab panels are mounted `hidden` and don't count).
  const visibleText = () => {
    const clone = utils.container.cloneNode(true) as HTMLElement;
    for (const h of clone.querySelectorAll("[hidden]")) h.remove();
    return clone.textContent ?? "";
  };
  return { ...utils, tabs, tab, visibleText };
}

describe("AccountHoldingsCards — empty states", () => {
  it("no balances at all → 'no snapshot yet'", () => {
    const { container } = mount([]);
    expect(container.textContent).toBe(to.noSnapshot);
  });

  it("balances but all dust → 'only zero-value holdings' (not blank)", () => {
    const { container } = mount([spot("dust", 0.01)]);
    expect(container.textContent).toBe(to.onlyDustHoldings);
  });

  it("nothing to show but an account-level note → renders the note, no empty state", () => {
    const note: Note = { title: "Unconfirmed", content: "1 pending tx", icon: "warning" };
    const { container } = mount([], [note]);
    expect(container.textContent).toContain("Unconfirmed");
    expect(container.textContent).not.toContain(to.noSnapshot);
  });
});

describe("AccountHoldingsCards — sections", () => {
  it("spot only → rows rendered directly, no tabs; sorted by USD value; uppercase symbol when no name", () => {
    const { tabs, container } = mount([
      spot("eth", 100, { name: "Ethereum" }),
      spot("btc", 500, { name: "Bitcoin" }),
      spot("pepe", 5),
    ]);
    expect(tabs()).toEqual([]);
    const text = container.textContent ?? "";
    expect(text.indexOf("Bitcoin")).toBeLessThan(text.indexOf("Ethereum"));
    expect(text.indexOf("Ethereum")).toBeLessThan(text.indexOf("PEPE"));
    expect(text).not.toContain("pepe"); // name slot uses the uppercase symbol, not the raw lowercase
  });

  it("spot splits by note.group into spot / funding / earn tabs, each with only its own tokens", () => {
    const { tabs, tab, visibleText } = mount([
      spot("btc", 500, { name: "Bitcoin" }),
      spot("usdt", 300, { name: "Tether", note: wallet("funding") }),
      spot("sol", 200, { name: "Solana", note: wallet("earn") }),
    ]);
    expect(tabs()).toEqual([to.tokensTab, to.fundingTab, to.earnTab]);

    // First tab by default: only spot is visible.
    expect(visibleText()).toContain("Bitcoin");
    expect(visibleText()).not.toContain("Tether");

    fireEvent.click(tab(to.fundingTab));
    expect(visibleText()).toContain("Tether");
    expect(visibleText()).not.toContain("Bitcoin");

    fireEvent.click(tab(to.earnTab));
    expect(visibleText()).toContain("Solana");
    expect(visibleText()).not.toContain("Tether");
  });

  it("perps: no positions and equity < $1 → no tab; equity ≥ $1 → tab", () => {
    expect(mount([spot("btc", 500), perpEquity(0.5)]).tabs()).toEqual([]);
    expect(mount([spot("btc", 500), perpEquity(25)]).tabs()).toEqual([to.tokensTab, to.perpsTab]);
  });

  it("DeFi positions get their own section", () => {
    const { tabs, tab, visibleText } = mount([
      spot("btc", 500, { name: "Bitcoin" }),
      defi("Aave", "USDC", 1000),
    ]);
    expect(tabs()).toEqual([to.tokensTab, to.defiTab]);
    fireEvent.click(tab(to.defiTab));
    expect(visibleText()).toContain("Aave");
    expect(visibleText()).not.toContain("Bitcoin");
  });

  it("account-level note with holdings → top accordion plus holdings", () => {
    const note: Note = { title: "Receiving address", content: "bc1q…", icon: "info" };
    const { container } = mount([spot("btc", 500, { name: "Bitcoin" })], [note]);
    const text = container.textContent ?? "";
    expect(text).toContain("Receiving address");
    expect(text.indexOf("Receiving address")).toBeLessThan(text.indexOf("Bitcoin"));
  });
});
