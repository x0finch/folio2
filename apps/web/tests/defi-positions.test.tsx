import { cleanup, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { IntlProvider } from "use-intl";
import { afterEach, describe, expect, it } from "vitest";
import type { DefiGroup, DefiRow } from "@/lib/core/account-view";
import { BalancePrivacyProvider } from "@/lib/hooks/use-balance-privacy";
import { messages } from "@/lib/i18n/messages";
import { DefiPositions } from "@/routes/_authed/-home/holdings/defi";

// DeFi positions (home DeFi tab and account sheet). The beUI hover Popover keeps its detail in the DOM
// while closed (just inert), so tests read that DOM directly.

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

const row = (
  id: string,
  symbol: string,
  amount: number,
  usdValue: number,
  role?: string,
): DefiRow => ({
  id,
  symbol,
  amount,
  usdValue,
  positionType: role,
});

const aave: DefiGroup = {
  protocol: "Aave",
  gain24h: { amount: 12, pct: 1.5 },
  rows: [
    row("1", "GHO", 843, 843, "deposit"),
    row("2", "WETH", 0.24, 600, "deposit"),
    row("3", "GHO", 219, -219, "loan"),
  ],
};

// Protocol row's ValueDelta: line 1 value, line 2 delta.
const protocolRow = (name: string) =>
  screen.getByText(name, { selector: ".truncate" }).parentElement?.parentElement as HTMLElement;
const valueLines = (name: string) =>
  [...(protocolRow(name).lastElementChild?.children ?? [])].map((e) => e.textContent);

const detail = (container: HTMLElement) => container.querySelector("[role=dialog]") as HTMLElement;

describe("protocol row", () => {
  it("net subtotal = assets − debts; 24h delta with sign and percent", () => {
    wrap(<DefiPositions groups={[aave]} />);
    expect(valueLines("Aave")).toEqual(["$1,224.00", "+$12.00 1.50%"]);
  });

  it("24h not computable → `—`, not blank", () => {
    wrap(<DefiPositions groups={[{ ...aave, gain24h: null }]} />);
    expect(valueLines("Aave")).toEqual(["$1,224.00", "—"]);
  });

  it("24h still loading → skeleton, not a dash", () => {
    wrap(<DefiPositions groups={[{ ...aave, gain24h: null }]} gainPending />);
    expect(valueLines("Aave")[1]).not.toBe("—");
    expect(protocolRow("Aave").querySelector("[data-slot=skeleton]")).toBeTruthy();
  });

  it("one row per protocol", () => {
    wrap(
      <DefiPositions groups={[aave, { protocol: "Lido", rows: [row("x", "stETH", 1, 3000)] }]} />,
    );
    expect(screen.getByText("Aave", { selector: ".truncate" })).toBeTruthy();
    expect(screen.getByText("Lido", { selector: ".truncate" })).toBeTruthy();
  });
});

describe("composition bar and detail", () => {
  it("bar labels each role; the bar's accessible label is the protocol name", () => {
    const { container } = wrap(<DefiPositions groups={[aave]} />);
    const labels = [...container.querySelectorAll("[data-lab]")].map((e) => e.textContent);
    expect(labels).toEqual(["deposit", "loan"]);
    expect(screen.getByRole("button", { name: "Aave" })).toBeTruthy();
  });

  it("detail groups legs by role; debt legs show − on amount and value", () => {
    const { container } = wrap(<DefiPositions groups={[aave]} />);
    const text = detail(container).textContent ?? "";
    expect(text).toContain("843 GHO$843.00");
    expect(text).toContain("0.24 WETH$600.00");
    expect(text).toContain("−219 GHO−$219.00");
    // Role order: deposit first (legs sorted by |usd| desc, first-seen role first).
    expect(text.indexOf("deposit")).toBeLessThan(text.indexOf("loan"));
  });
});

describe("privacy", () => {
  it("on → every leg's amount and value in the detail are masked", () => {
    const { container } = wrap(<DefiPositions groups={[aave]} />, true);
    const masked = [...detail(container).querySelectorAll("[role=button]")].map(
      (m) => m.textContent,
    );
    expect(masked).toEqual(["843 GHO", "$843.00", "0.24 WETH", "$600.00", "−219 GHO", "−$219.00"]);
  });
});
