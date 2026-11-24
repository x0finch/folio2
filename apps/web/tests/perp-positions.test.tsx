import { cleanup, render, screen, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { IntlProvider } from "use-intl";
import { afterEach, describe, expect, it } from "vitest";
import type { PerpPositionView, PerpView } from "@/lib/core/account-view";
import { BalancePrivacyProvider } from "@/lib/hooks/use-balance-privacy";
import { messages } from "@/lib/i18n/messages";
import {
  PerpPositions,
  PerpPositionsList,
  type PerpSectionItem,
} from "@/routes/_authed/-home/holdings/perp";

// The beUI hover Popover keeps details in the DOM when closed, so they are assertable.

afterEach(cleanup);

function wrap(ui: ReactNode, hide?: boolean) {
  const tree = (
    <IntlProvider locale="en" messages={messages.en} timeZone="UTC">
      {ui}
    </IntlProvider>
  );
  return render(
    hide == null ? (
      tree
    ) : (
      <BalancePrivacyProvider hideBalances={hide}>{tree}</BalancePrivacyProvider>
    ),
  );
}

const pos = (over: Partial<PerpPositionView> = {}): PerpPositionView => ({
  coin: "BTC",
  side: "long",
  entryPx: 50_000,
  positionValue: 6_000,
  unrealizedPnl: 1_000,
  leverage: 3,
  leverageType: "cross",
  liquidationPx: 40_000,
  marginUsed: 200,
  size: 0.1,
  ...over,
});

const ethShortNoLiq = pos({
  coin: "ETH",
  side: "short",
  entryPx: 2_000,
  positionValue: 2_000,
  unrealizedPnl: -50,
  leverage: undefined,
  leverageType: undefined,
  liquidationPx: null,
  marginUsed: 100,
  size: -1,
});

const view = (over: Partial<PerpView> = {}): PerpView => ({
  equity: { accountValue: 1_000, withdrawable: 400, totalMarginUsed: 250, totalNtlPos: 3_000 },
  positions: [pos(), ethShortNoLiq],
  ...over,
});

// Stat: label and value are adjacent divs; find the label and take its sibling.
const stat = (label: string) => screen.getByText(label).nextElementSibling?.textContent;

describe("Account equity bar", () => {
  it("six figures: equity, summed uPnL, margin usage %, withdrawable, notional, account leverage", () => {
    wrap(<PerpPositions view={view()} />);
    expect(stat("Equity")).toBe("$1,000.00");
    expect(stat("uPnL")).toBe("+$950.00"); // 1000 + (−50)
    expect(stat("Margin usage")).toBe("25%"); // 250 / 1000
    expect(stat("Withdrawable")).toBe("$400.00");
    expect(stat("Notional")).toBe("$3,000.00");
    expect(stat("Acct. leverage")).toBe("3.00x"); // 3000 / 1000
  });

  it("zero equity -> no margin usage or account leverage (no divide by zero)", () => {
    wrap(
      <PerpPositions
        view={view({
          equity: { accountValue: 0, withdrawable: 0, totalMarginUsed: 10, totalNtlPos: 100 },
        })}
      />,
    );
    expect(screen.queryByText("Margin usage")).toBeNull();
    expect(screen.queryByText("Acct. leverage")).toBeNull();
    expect(stat("Equity")).toBe("$0.00");
  });

  it("no equity row -> bar hidden, positions still shown", () => {
    wrap(<PerpPositions view={view({ equity: null })} />);
    expect(screen.queryByText("Equity")).toBeNull();
    expect(screen.getByText("BTC", { exact: false })).toBeTruthy();
  });
});

describe("Position row", () => {
  it("side pill carries leverage, size is absolute; without leverage only the side", () => {
    const { container } = wrap(<PerpPositions view={view()} hideHeader />);
    const text = container.textContent ?? "";
    expect(text).toContain("3x Long");
    expect(text).toContain("0.1 BTC");
    expect(text).toContain("Short");
    expect(text).not.toContain("x Short");
    expect(text).toContain("1 ETH"); // size = -1 -> 1
    expect(text).not.toContain("-1 ETH");
  });

  it("has a liquidation price -> risk ring; details show margin mode / used / buffer / entry / mark / liq", () => {
    wrap(<PerpPositions view={view({ positions: [pos()] })} hideHeader />);
    const ring = screen.getByRole("button", { name: "Safety margin" });
    expect(ring).toBeTruthy();
    // Details: mark = 6000 / 0.1 = 60,000; buffer = (60000 - 40000) / 60000 ~ 33%
    const detail = (label: string) =>
      screen.getAllByText(label).at(-1)?.nextElementSibling?.textContent;
    expect(detail("Margin mode")).toBe("Cross");
    expect(detail("Margin used")).toBe("$200.00");
    expect(detail("Safety margin")).toBe("33%");
    expect(detail("Mark")).toBe("$60,000.00");
    expect(detail("Liq.")).toBe("$40,000.00");
    expect(detail("Entry")).toBe("$50,000.00");
  });

  it("no liquidation price -> no ring, falls back to 'Entry $x'", () => {
    const { container } = wrap(
      <PerpPositions view={view({ positions: [ethShortNoLiq] })} hideHeader />,
    );
    expect(screen.queryByRole("button", { name: "Safety margin" })).toBeNull();
    expect(container.textContent).toContain("Entry $2,000.00");
  });

  it("no margin mode -> that detail row is omitted", () => {
    wrap(
      <PerpPositions view={view({ positions: [pos({ leverageType: undefined })] })} hideHeader />,
    );
    expect(screen.queryByText("Margin mode")).toBeNull();
  });
});

// The ring's colored arc is the second circle's strokeDasharray "arc circumference"; ratio = fill.
function ringFill(container: HTMLElement): number {
  const arc = container.querySelectorAll("svg circle")[1];
  const [len, circ] = (arc?.getAttribute("stroke-dasharray") ?? "").split(" ").map(Number);
  return len / circ;
}

describe("Risk ring fill", () => {
  // Long entry 100 / liq 90, size 1 -> mark price = positionValue.
  const at = (mark: number) =>
    pos({ entryPx: 100, liquidationPx: 90, size: 1, positionValue: mark, leverageType: undefined });

  it("past the liquidation price -> full ring (terminal), buffer shows 0%", () => {
    const { container } = wrap(<PerpPositions view={view({ positions: [at(85)] })} hideHeader />);
    expect(ringFill(container)).toBeCloseTo(1, 5);
    expect(screen.getAllByText("Safety margin").at(-1)?.nextElementSibling?.textContent).toBe("0%");
  });
});

describe("Multi-account list (home Perps tab)", () => {
  const item = (
    id: string,
    equity: number,
    over: Partial<PerpSectionItem> = {},
  ): PerpSectionItem => ({
    id,
    view: view({
      equity: { accountValue: equity, withdrawable: 0, totalMarginUsed: 0, totalNtlPos: 0 },
      positions: [],
    }),
    ...over,
  });

  it("sorted by equity descending, accounts without equity last", () => {
    const { container } = wrap(
      <PerpPositionsList
        items={[
          item("a", 100, { accountLabel: "Small" }),
          { ...item("b", 0, { accountLabel: "None" }), view: { equity: null, positions: [] } },
          item("c", 900, { accountLabel: "Big" }),
        ]}
      />,
    );
    const heads = [...container.querySelectorAll(".truncate.font-medium")].map(
      (e) => e.textContent,
    );
    expect(heads).toEqual(["Big", "Small", "None"]);
  });

  it("with platform -> platform name on the main line, @account on the sub line; without -> account name", () => {
    wrap(
      <PerpPositionsList
        items={[
          item("a", 900, { platform: { name: "Hyperliquid" }, accountLabel: "Main" }),
          item("b", 100, { accountLabel: "Solo" }),
        ]}
      />,
    );
    expect(screen.getByText("Hyperliquid")).toBeTruthy();
    expect(screen.getByText("@Main")).toBeTruthy();
    expect(screen.getByText("Solo")).toBeTruthy();
    expect(screen.queryByText("@Solo")).toBeNull();
  });
});

describe("Privacy", () => {
  it("on -> money is masked; margin usage, leverage, side, entry price are not", () => {
    const { container } = wrap(<PerpPositions view={view()} hideHeader />, true);
    const masked = screen
      .getAllByRole("button", { name: /balance hidden/i })
      .map((m) => m.textContent);
    expect(masked).toEqual(
      expect.arrayContaining(["$1,000.00", "+$950.00", "$400.00", "$3,000.00", "0.1", "$200.00"]),
    );
    expect(stat("Margin usage")).toBe("25%");
    expect(stat("Acct. leverage")).toBe("3.00x");
    expect(container.textContent).toContain("Entry $2,000.00");
    // The unmasked 'Entry $x' is not inside any mask.
    for (const m of screen.getAllByRole("button", { name: /balance hidden/i })) {
      expect(within(m).queryByText(/Entry/)).toBeNull();
    }
  });
});
