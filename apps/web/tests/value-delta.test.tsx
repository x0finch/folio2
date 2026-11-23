import { cleanup, render } from "@testing-library/react";
import { IntlProvider } from "use-intl";
import { afterEach, describe, expect, it } from "vitest";
import { deltaTone, NO_VALUE, ValueDelta } from "@/routes/_authed/-home/holdings/value-delta";

afterEach(cleanup);

function renderDelta(props: Partial<React.ComponentProps<typeof ValueDelta>> = {}) {
  return render(
    <IntlProvider locale="en" messages={{}} timeZone="UTC" now={new Date(0)}>
      <ValueDelta value={1000} {...props} />
    </IntlProvider>,
  );
}

function deltaLine(container: HTMLElement): HTMLElement | null {
  return (container.firstElementChild?.children[1] as HTMLElement | undefined) ?? null;
}

describe("three states of <ValueDelta>", () => {
  it("undefined: whole row omitted (archived row: number frozen, a delta is meaningless)", () => {
    const { container } = renderDelta({ delta: undefined });
    expect(deltaLine(container)).toBeNull();
  });

  it("null: shows `—`, not blank", () => {
    const { container } = renderDelta({ delta: null });
    expect(deltaLine(container)?.textContent).toBe(NO_VALUE);
  });

  it('0: shows amount 0, not swallowed as "none"', () => {
    const { container } = renderDelta({ delta: 0 });
    const line = deltaLine(container);
    expect(line).not.toBeNull();
    expect(line?.textContent).not.toBe(NO_VALUE);
    expect(line?.textContent).toMatch(/0/);
  });

  it("loading: small skeleton, not a dash", () => {
    const { container } = renderDelta({ delta: null, loading: true });
    expect(deltaLine(container)?.textContent).not.toBe(NO_VALUE);
    expect(container.querySelector("[data-slot=skeleton]")).toBeTruthy();
  });
});

describe("direction and percentage of <ValueDelta>", () => {
  it("positive carries + and the gain colour", () => {
    const { container } = renderDelta({ delta: 12.5 });
    const line = deltaLine(container);
    expect(line?.textContent).toContain("+");
    expect(line?.className).toContain("text-pos");
  });

  it("negative carries a real minus sign and the loss colour", () => {
    const { container } = renderDelta({ delta: -12.5 });
    const line = deltaLine(container);
    expect(line?.textContent).toContain("−");
    expect(line?.className).toContain("text-neg");
  });

  it("pct follows the amount when present, otherwise only the amount", () => {
    const withPct = renderDelta({ delta: 12.5, pct: 2.345 });
    expect(deltaLine(withPct.container)?.textContent).toContain("2.35%"); // toFixed(2)
    const without = renderDelta({ delta: 12.5 });
    expect(deltaLine(without.container)?.textContent).not.toContain("%");
  });

  it("negative market value (DeFi net debt) still uses the loss colour, independent of delta", () => {
    const { container } = renderDelta({ value: -500, delta: 1 });
    const valueLine = container.firstElementChild?.firstElementChild as HTMLElement;
    expect(valueLine.className).toContain("text-neg");
  });
});

describe("deltaTone", () => {
  it("not computable and unchanged both carry no direction: colouring 0 would imply a direction that does not exist", () => {
    expect(deltaTone(null)).toBe(deltaTone(0));
    expect(deltaTone(0)).toContain("muted");
  });

  it("positive and negative each carry their colour", () => {
    expect(deltaTone(1)).toContain("pos");
    expect(deltaTone(-1)).toContain("neg");
  });
});
