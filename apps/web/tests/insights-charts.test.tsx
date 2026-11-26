import type { Currency } from "@folio/oracle-basic";
import { SUPPORTED_CURRENCIES } from "@folio/oracle-basic";
import { cleanup, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { IntlProvider } from "use-intl";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { HistoryPoint } from "@/lib/core/history";
import { BalancePrivacyProvider } from "@/lib/hooks/use-balance-privacy";
import { CurrencyProvider } from "@/lib/hooks/use-prefer-currency";
import { messages } from "@/lib/i18n/messages";
import { OTHERS_KEY } from "@/routes/_authed/-insights/allocation";
import { AllocationPie } from "@/routes/_authed/-insights/allocation-pie";
import { PortfolioChart } from "@/routes/_authed/-insights/portfolio-chart";

//

const DAY = 86_400_000;
const T0 = Date.UTC(2026, 0, 10);

class SizedResizeObserver {
  constructor(private readonly cb: ResizeObserverCallback) {}
  observe(target: Element) {
    this.cb(
      [{ target, contentRect: { width: 600, height: 220 } } as unknown as ResizeObserverEntry],
      this as unknown as ResizeObserver,
    );
  }
  unobserve() {}
  disconnect() {}
}

const originalRO = globalThis.ResizeObserver;
beforeEach(() => {
  globalThis.ResizeObserver = SizedResizeObserver as unknown as typeof ResizeObserver;
});
afterEach(() => {
  globalThis.ResizeObserver = originalRO;
  cleanup();
});

const EUR = SUPPORTED_CURRENCIES.find((c) => c.code === "EUR") as Currency;

function wrap(
  ui: ReactNode,
  opts: { currency?: { currency: Currency; rate: number }; hide?: boolean } = {},
) {
  let tree = (
    <IntlProvider locale="en" messages={messages.en} timeZone="UTC" now={new Date(T0)}>
      {ui}
    </IntlProvider>
  );
  if (opts.currency) tree = <CurrencyProvider value={opts.currency}>{tree}</CurrencyProvider>;
  if (opts.hide != null)
    tree = <BalancePrivacyProvider hideBalances={opts.hide}>{tree}</BalancePrivacyProvider>;
  return render(tree);
}

const series = (points: [number, number][]): HistoryPoint[] =>
  points.map(([t, total]) => ({ t, total }));

// The chart's values are also rendered as a table for screen readers; it shows what the readout shows.
describe("PortfolioChart: currency and privacy", () => {
  it("amounts convert to the preferred currency", () => {
    const { container } = wrap(
      <PortfolioChart
        series={series([
          [T0 - 5 * DAY, 1_000],
          [T0, 13_100],
        ])}
      />,
      { currency: { currency: EUR, rate: 0.5 } },
    );
    const text = container.querySelector("table")?.textContent ?? "";
    expect(text).toContain("€26,200.00");
    expect(text).not.toContain("$");
  });

  it("privacy on: values are withheld, not just blurred", () => {
    const { container } = wrap(
      <PortfolioChart
        series={series([
          [T0 - 5 * DAY, 1_000],
          [T0, 13_100],
        ])}
      />,
      { hide: true },
    );
    const text = container.textContent ?? "";
    expect(text).not.toContain("13,100");
    expect(container.querySelector("table")?.textContent).toContain("•••");
  });
});

const legendRows = (container: HTMLElement) =>
  [...container.querySelectorAll("li")].map((li) => li.textContent ?? "");

describe("AllocationPie: legend", () => {
  it("no slices: shows the no-data hint, draws no pie", () => {
    const { container } = wrap(<AllocationPie slices={[]} />);
    expect(screen.getByText("No data yet.")).toBeTruthy();
    expect(container.querySelector("li")).toBeNull();
  });

  it('one row per slice: name · rounded share · amount; the merged tail shows "Others"', () => {
    const { container } = wrap(
      <AllocationPie
        slices={[
          { key: "btc", label: "BTC", value: 666 },
          { key: "eth", label: "ETH", value: 234 },
          { key: OTHERS_KEY, label: OTHERS_KEY, value: 100 },
        ]}
      />,
    );
    expect(legendRows(container)).toEqual(["BTC67%$666.00", "ETH23%$234.00", "Others10%$100.00"]);
  });

  it("total 0: the no-data hint, no NaN", () => {
    const { container } = wrap(<AllocationPie slices={[{ key: "x", label: "X", value: 0 }]} />);
    expect(screen.getByText("No data yet.")).toBeTruthy();
    expect(container.textContent).not.toContain("NaN");
  });

  it("amounts convert to the preferred currency", () => {
    const { container } = wrap(
      <AllocationPie slices={[{ key: "btc", label: "BTC", value: 50 }]} />,
      {
        currency: { currency: EUR, rate: 0.5 },
      },
    );
    expect(legendRows(container)).toEqual(["BTC100%€100.00"]);
  });

  it("privacy on: each slice amount masked, share kept", () => {
    wrap(
      <AllocationPie
        slices={[
          { key: "btc", label: "BTC", value: 75 },
          { key: "eth", label: "ETH", value: 25 },
        ]}
      />,
      { hide: true },
    );
    const masked = screen.getAllByRole("button", { name: /balance hidden/i });
    expect(masked.map((m) => m.textContent)).toEqual(["$75.00", "$25.00"]);
    expect(screen.getByText("75%")).toBeTruthy();
  });
});
