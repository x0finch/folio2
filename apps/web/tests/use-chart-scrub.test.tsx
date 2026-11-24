import { act, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { IntlProvider } from "use-intl";
import { describe, expect, it } from "vitest";
import { useChartScrub } from "@/lib/hooks/use-chart-scrub";

function wrap({ children }: { children: ReactNode }) {
  return (
    <IntlProvider locale="en" messages={{}} timeZone="UTC" now={new Date(0)}>
      {children}
    </IntlProvider>
  );
}

const AUG_12_1530_UTC = Date.UTC(2026, 7, 12, 15, 30);

describe("useChartScrub", () => {
  it("not scrubbing: no point, no time (caller shows the live value)", () => {
    const { result } = renderHook(() => useChartScrub(), { wrapper: wrap });
    expect(result.current.point).toBeNull();
    expect(result.current.label).toBeNull();
  });

  it("scrubbing to a point: gives that point + month/day/hour/minute", () => {
    const { result } = renderHook(() => useChartScrub(), { wrapper: wrap });
    act(() => {
      result.current.onActive({ t: AUG_12_1530_UTC, total: 1234 });
    });
    expect(result.current.point).toEqual({ t: AUG_12_1530_UTC, total: 1234 });
    expect(result.current.label).toContain("Aug");
    expect(result.current.label).toContain("12");
    expect(result.current.label).toMatch(/03:30|15:30/);
  });

  it("release / leave: back to the live value state", () => {
    const { result } = renderHook(() => useChartScrub(), { wrapper: wrap });
    act(() => {
      result.current.onActive({ t: AUG_12_1530_UTC, total: 1234 });
    });
    act(() => {
      result.current.onActive(null);
    });
    expect(result.current.point).toBeNull();
    expect(result.current.label).toBeNull();
  });
});
