import { cleanup, render, screen } from "@testing-library/react";
import { IntlProvider } from "use-intl";
import { afterEach, describe, expect, it } from "vitest";
import type { HistoryPoint } from "@/lib/core/history";
import { messages } from "@/lib/i18n/messages";
import type { HoldingLike } from "@/routes/_authed/-home/hero/hero-stats";
import { PortfolioHero } from "@/routes/_authed/-home/hero/portfolio-hero";

afterEach(cleanup);

// Hero trend area has three states; the fake demo curve must never show next to a real figure.
// jsdom has zero container size so recharts renders nothing; the states are told apart by the
// `{spanDays}D` span badge (only with real history) and the empty-state sentence.
const DAY = 86_400_000;
const T0 = 1_700_000_000_000;

const holdings: readonly HoldingLike[] = [
  { token: { symbol: "BTC" }, totalValue: 100, gain24h: { amount: 1, pct: 1 } },
];

function renderHero(series: HistoryPoint[], totalUsd: number, held = holdings) {
  return render(
    <IntlProvider locale="en" messages={messages.en} timeZone="UTC" now={new Date(T0)}>
      <PortfolioHero series={series} totalUsd={totalUsd} gain24h={null} holdings={held} />
    </IntlProvider>,
  );
}

const emptyText = () => screen.queryByText(/once it's ready/i);
// Span badge like `11D`: only when hasHistory and the span is >= 1 day.
const spanBadge = () => screen.queryByText(/^\d+D$/);

describe("Hero trend area's three states", () => {
  it("(1) has history (>= 2 points) -> real curve, no empty-state sentence", () => {
    renderHero(
      [
        { t: T0 - 3 * DAY, total: 100 },
        { t: T0, total: 110 },
      ],
      110,
    );

    expect(spanBadge()).toBeTruthy(); // 3D
    expect(emptyText()).toBeNull();
  });

  it("(2) has value but only one point -> explains why, never draws the fake curve", () => {
    renderHero([{ t: T0, total: 110 }], 110);

    expect(emptyText()).toBeTruthy();
    expect(spanBadge()).toBeNull();
  });

  it("(3) nothing yet (no holdings + total 0) -> keeps the decorative curve, no 'not enough data'", () => {
    // Nothing here can contradict the decorative curve, and the add-account prompt says enough.
    renderHero([], 0, []);

    expect(emptyText()).toBeNull();
    expect(spanBadge()).toBeNull();
  });

  it("no points but has holdings -> still explains, no decoration", () => {
    // Archive/import paths can yield an empty series with holdings; the test is "anything held".
    renderHero([], 110);

    expect(emptyText()).toBeTruthy();
  });

  it("negative net value -> explains, never draws the rising decorative curve", () => {
    // Why the check is `nothingYet`, not `totalUsd > 0`: a blown-up perp makes net value negative.
    renderHero([{ t: T0, total: -500 }], -500);

    expect(emptyText()).toBeTruthy();
  });

  it("dust holding worth exactly 0 -> explains, no decoration", () => {
    // Holding a position is not "nothing yet", even if it is worth nothing now.
    renderHero([], 0, [{ token: { symbol: "BTC" }, totalValue: 0, gain24h: null }]);

    expect(emptyText()).toBeTruthy();
  });

  it("trend still loading -> net value renders, no flash of the empty-state sentence", () => {
    // The curve is a non-suspending read; don't block the figure or flash 'not enough data'.
    render(
      <IntlProvider locale="en" messages={messages.en} timeZone="UTC" now={new Date(T0)}>
        <PortfolioHero series={[]} totalUsd={110} gain24h={null} holdings={holdings} loading />
      </IntlProvider>,
    );

    expect(screen.getByText(/total net worth/i)).toBeTruthy();
    expect(emptyText()).toBeNull();
    expect(spanBadge()).toBeNull();
  });

  it("two points in the same clock hour -> downsampled into one, so still the empty state", () => {
    // Records current behavior, not endorses it: the finest downsample bucket is one clock hour, so
    // two syncs in the same hour keep only the last point. If that changes, revisit the copy here.
    const sameHour = new Date("2026-08-11T10:00:00Z").getTime();
    renderHero(
      [
        { t: sameHour + 5 * 60_000, total: 100 },
        { t: sameHour + 55 * 60_000, total: 110 },
      ],
      110,
    );

    expect(emptyText()).toBeTruthy();
  });
});
