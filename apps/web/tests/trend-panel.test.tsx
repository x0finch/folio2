import { cleanup, render, screen } from "@testing-library/react";
import { IntlProvider } from "use-intl";
import { afterEach, describe, expect, it } from "vitest";
import type { HistoryPoint } from "@/lib/core/history";
import { messages } from "@/lib/i18n/messages";
import { TrendPanel } from "@/routes/_authed/-home/hero/trend-panel";

afterEach(cleanup);

//
const T0 = 1_700_000_000_000;
const DAY = 86_400_000;

const two: HistoryPoint[] = [
  { t: T0 - DAY, total: 100 },
  { t: T0, total: 110 },
];

function renderPanel(props: Partial<Parameters<typeof TrendPanel>[0]> = {}) {
  const { container } = render(
    <IntlProvider locale="en" messages={messages.en} timeZone="UTC" now={new Date(T0)}>
      <TrendPanel series={[]} height={128} {...props} />
    </IntlProvider>,
  );
  return container;
}

const note = () => screen.queryByText(/once it's ready/i);
const chartWrapper = (c: HTMLElement) =>
  c.querySelector("[data-slot=sparkline]:not([aria-hidden])");
const decoration = (c: HTMLElement) => c.querySelector("[class*='pointer-events-none']");

describe("four states", () => {
  it("two or more points: draws the chart, no copy", () => {
    const c = renderPanel({ series: two });
    expect(chartWrapper(c)).toBeTruthy();
    expect(note()).toBeNull();
  });

  it("too few points: shows copy", () => {
    const c = renderPanel({ series: [{ t: T0, total: 110 }] });
    expect(note()).toBeTruthy();
    expect(chartWrapper(c)).toBeNull();
  });

  it("still loading: renders nothing (otherwise copy flashes then is covered by the chart)", () => {
    const c = renderPanel({ loading: true });
    expect(note()).toBeNull();
    expect(c.firstChild).toBeNull();
  });

  it("while loading decorate also yields: do not draw the decoration yet", () => {
    const c = renderPanel({ loading: true, decorate: true });
    expect(note()).toBeNull();
    expect(decoration(c)).toBeNull();
    expect(c.firstChild).toBeNull();
  });

  it("decorate: draws the decorative pattern, no copy", () => {
    const c = renderPanel({ decorate: true });
    expect(note()).toBeNull();
    expect(decoration(c)).toBeTruthy();
  });

  it("**decorate yields to real data**: with both on, the real chart is drawn", () => {
    const c = renderPanel({ series: two, decorate: true });
    expect(chartWrapper(c)).toBeTruthy();
    expect(note()).toBeNull();
  });
});
