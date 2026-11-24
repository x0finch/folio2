import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, waitFor } from "@testing-library/react";
import { IntlProvider } from "use-intl";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TokenOption } from "@/lib/core/token-model";
import { messages } from "@/lib/i18n/messages";

const s = vi.hoisted(() => ({
  listTokenCatalogue: vi.fn(),
  listFiatOptions: vi.fn(),
  listTokens: vi.fn(),
  refreshTokenPrices: vi.fn(),
}));

vi.mock("@/lib/server/tokens", () => ({
  ...s,
  getTokenEnrichment: vi.fn(),
  getTokenPrice: vi.fn(),
}));

const { TokenCombobox } = await import("@/components/token-combobox");

Element.prototype.scrollIntoView = vi.fn();

const ta = messages.en.Accounts;
const fresh = Date.now();
const tok = (symbol: string, name: string, extra: Partial<TokenOption> = {}): TokenOption => ({
  ticket: `tk:${symbol}`,
  symbol,
  name,
  asOf: fresh,
  ...extra,
});
const BTC = tok("btc", "Bitcoin", { rank: 1, price: 60000, change24h: 1.5 });
const ETH = tok("eth", "Ethereum", { rank: 2, price: 3000, change24h: -2 });
const USD = tok("usd", "US Dollar", { price: 1 });

function mount(
  props: { value?: TokenOption | null; owned?: TokenOption[] } = {},
  catalogue: TokenOption[] | Error = [BTC, ETH],
  fiat: TokenOption[] = [USD],
) {
  if (catalogue instanceof Error) s.listTokenCatalogue.mockRejectedValue(catalogue);
  else s.listTokenCatalogue.mockResolvedValue(catalogue);
  s.listFiatOptions.mockResolvedValue(fiat);
  const onChange = vi.fn();
  const onManual = vi.fn();
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const utils = render(
    <QueryClientProvider client={client}>
      <IntlProvider locale="en" messages={messages.en} timeZone="UTC">
        <div>
          <TokenCombobox
            value={props.value ?? null}
            onChange={onChange}
            onManual={onManual}
            owned={props.owned}
          />
          <button type="button">outside</button>
        </div>
      </IntlProvider>
    </QueryClientProvider>,
  );
  const input = () => utils.container.querySelector("input") as HTMLInputElement | null;
  const root = () => utils.container.firstElementChild?.firstElementChild as HTMLElement;
  const open = () => fireEvent.click(utils.container.querySelector("button") as HTMLElement);
  const type = (q: string) =>
    fireEvent.change(input() as HTMLInputElement, { target: { value: q } });
  const key = (k: string) => fireEvent.keyDown(input() as HTMLInputElement, { key: k });
  const rows = () =>
    [...utils.container.querySelectorAll("button[data-index]")] as HTMLButtonElement[];
  const row = (name: string) => rows().find((r) => r.textContent?.includes(name)) as HTMLElement;
  const text = () => utils.container.textContent ?? "";
  return { ...utils, onChange, onManual, input, root, open, type, key, rows, row, text };
}

beforeEach(() => {
  vi.clearAllMocks();
  s.listTokens.mockResolvedValue([]);
  s.refreshTokenPrices.mockResolvedValue([]);
});

describe("TokenCombobox: collapsed state", () => {
  it("nothing selected: placeholder; selected: uppercase symbol + name", () => {
    expect(mount().text()).toContain(ta.searchTokenPlaceholder);
    const picked = mount({ value: BTC }).text();
    expect(picked).toContain("BTC");
    expect(picked).toContain("Bitcoin");
  });

  it("click ×: onChange(null), does not expand", () => {
    const { container, onChange, input } = mount({ value: BTC });
    fireEvent.click(container.querySelector("button svg:last-child") as Element);
    expect(onChange).toHaveBeenCalledWith(null);
    expect(input()).toBeNull();
  });
});

describe("TokenCombobox: browse and search", () => {
  it("expand: grouped list of owned / tokens / cash", async () => {
    const owned = [tok("sol", "Solana")];
    const { open, text, rows } = mount({ owned });
    open();
    await waitFor(() => expect(rows()).toHaveLength(4));
    const t = text();
    expect(t.indexOf(ta.sectionOwned)).toBeLessThan(t.indexOf(ta.sectionCatalogue));
    expect(t.indexOf(ta.sectionCatalogue)).toBeLessThan(t.indexOf(ta.sectionFiat));
    expect(t).toContain("Solana");
    expect(t).toContain("US Dollar");
  });

  it("rows show price and 24h change", async () => {
    const { open, row } = mount();
    open();
    await waitFor(() => expect(row("Bitcoin")).toBeTruthy());
    expect(row("Bitcoin").textContent).toContain("+1.50%");
    expect(row("Ethereum").textContent).toContain("-2.00%");
  });

  it("typing: filters locally at once", async () => {
    const { open, type, rows, row } = mount();
    open();
    await waitFor(() => expect(rows().length).toBeGreaterThan(0));
    type("ethe");
    expect(rows().map((r) => r.textContent)).toHaveLength(1);
    expect(row("Ethereum")).toBeTruthy();
  });

  it("local results insufficient: debounced, asks upstream once, results merge into the list", async () => {
    s.listTokens.mockResolvedValue([tok("pepe", "Pepe")]);
    const { open, type, row } = mount();
    open();
    await waitFor(() => expect(s.listTokenCatalogue).toHaveBeenCalled());
    type("pe");
    type("pep");
    type("pepe");
    await waitFor(() => expect(row("Pepe")).toBeTruthy());
    expect(s.listTokens).toHaveBeenCalledTimes(1);
    expect(s.listTokens).toHaveBeenCalledWith({ data: { query: "pepe" } });
  });

  it("enough local hits: does not ask upstream", async () => {
    const many = Array.from({ length: 10 }, (_, i) =>
      tok(`w${i}`, `Wrapped ${i}`, { rank: i + 1 }),
    );
    const { open, type, rows } = mount({}, many);
    open();
    await waitFor(() => expect(rows().length).toBeGreaterThan(0));
    type("wrapped");
    await new Promise((r) => setTimeout(r, 400));
    expect(rows().length).toBeGreaterThanOrEqual(8);
    expect(s.listTokens).not.toHaveBeenCalled();
  });

  it("a single typed character: does not ask upstream", async () => {
    const { open, type, rows } = mount();
    open();
    await waitFor(() => expect(rows().length).toBeGreaterThan(0));
    type("z");
    await new Promise((r) => setTimeout(r, 400));
    expect(s.listTokens).not.toHaveBeenCalled();
  });
});

describe("TokenCombobox: selection and collapse", () => {
  it("click a row: onChange(the token, with its display price) and collapses", async () => {
    const { open, row, onChange, input } = mount();
    open();
    await waitFor(() => expect(row("Ethereum")).toBeTruthy());
    fireEvent.click(row("Ethereum"));
    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({ ticket: ETH.ticket, price: 3000 }),
    );
    expect(input()).toBeNull();
  });

  it("↓ then Enter: selects the second row", async () => {
    const { open, key, rows, onChange } = mount();
    open();
    await waitFor(() => expect(rows().length).toBe(3));
    key("ArrowDown");
    key("Enter");
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ ticket: ETH.ticket }));
  });

  it("↓↓ then ↑ then Enter: back to the second row", async () => {
    const { open, key, rows, onChange } = mount();
    open();
    await waitFor(() => expect(rows().length).toBe(3));
    key("ArrowDown");
    key("ArrowDown");
    key("ArrowUp");
    key("Enter");
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ ticket: ETH.ticket }));
  });

  it("Esc: collapses, selection unchanged", async () => {
    const { open, key, rows, onChange, input } = mount();
    open();
    await waitFor(() => expect(rows().length).toBe(3));
    key("Escape");
    expect(input()).toBeNull();
    expect(onChange).not.toHaveBeenCalled();
  });

  it("click outside the component: collapses, selection unchanged", async () => {
    const { open, rows, onChange, input, getByText } = mount();
    open();
    await waitFor(() => expect(rows().length).toBe(3));
    fireEvent.pointerDown(getByText("outside"));
    expect(input()).toBeNull();
    expect(onChange).not.toHaveBeenCalled();
  });
});

describe("TokenCombobox: no results / errors", () => {
  it('no results: the "enter manually" button calls onManual(query)', async () => {
    const { open, type, onManual, text, getByText } = mount();
    open();
    await waitFor(() => expect(s.listTokenCatalogue).toHaveBeenCalled());
    type("zzzz");
    await waitFor(() => expect(text()).toContain(ta.noResults));
    fireEvent.click(getByText(ta.customEntry.replace("{query}", "zzzz")));
    expect(onManual).toHaveBeenCalledWith("zzzz");
  });

  it("Enter with no results: also calls onManual", async () => {
    const { open, type, key, onManual, text } = mount();
    open();
    await waitFor(() => expect(s.listTokenCatalogue).toHaveBeenCalled());
    type("zzzz");
    await waitFor(() => expect(text()).toContain(ta.noResults));
    key("Enter");
    expect(onManual).toHaveBeenCalledWith("zzzz");
  });

  it("catalogue fetch fails with nothing at hand: reports search failure", async () => {
    const { open, text } = mount({}, new Error("down"), []);
    open();
    await waitFor(() => expect(text()).toContain(ta.searchFailed));
  });

  it("catalogue fetch fails but other options remain (fiat): listed as usual, no error", async () => {
    const { open, text, row } = mount({}, new Error("down"));
    open();
    await waitFor(() => expect(row("US Dollar")).toBeTruthy());
    expect(text()).not.toContain(ta.searchFailed);
  });
});

describe("TokenCombobox: price top-up on expand", () => {
  it("within one opening, topped-up tickets are not topped up again (even if that attempt failed and the list changed)", async () => {
    const stale = tok("doge", "Dogecoin", { asOf: undefined });
    s.refreshTokenPrices.mockRejectedValue(new Error("rate limited"));
    const { open, type, rows } = mount({}, [BTC, stale]);
    open();
    await waitFor(() => expect(s.refreshTokenPrices).toHaveBeenCalledTimes(1));
    type("dog");
    await waitFor(() => expect(rows()).toHaveLength(1));
    await new Promise((r) => setTimeout(r, 400));
    expect(s.refreshTokenPrices).toHaveBeenCalledTimes(1);
  });

  it("rows with expired prices: refreshed in one batch, fresh prices shown on rows and carried out on selection", async () => {
    const stale = tok("doge", "Dogecoin", { asOf: undefined, price: 0.1 });
    s.refreshTokenPrices.mockResolvedValue([
      { ticket: stale.ticket, unitPrice: 0.25, change24h: 5, asOf: Date.now() },
    ]);
    const { open, row, onChange } = mount({}, [BTC, stale]);
    open();
    await waitFor(() =>
      expect(s.refreshTokenPrices).toHaveBeenCalledWith({ data: { tickets: [stale.ticket] } }),
    );
    await waitFor(() => expect(row("Dogecoin").textContent).toContain("+5.00%"));
    expect(row("Dogecoin").textContent).toContain("0.25");
    fireEvent.click(row("Dogecoin"));
    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({ ticket: stale.ticket, price: 0.25, change24h: 5 }),
    );
  });
});
