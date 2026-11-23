import type { ConnectorId } from "@folio/connectors";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, waitFor } from "@testing-library/react";
import { IntlProvider } from "use-intl";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TokenOption } from "@/lib/core/token-model";
import { messages } from "@/lib/i18n/messages";
import type { InputSpec } from "@/lib/server/creds";

// AccountForm: generic, Bitcoin and manual branches each validate differently but all end in createAccount.
// Bitcoin asks for a script type only for a bare xpub; ypub/zpub imply it.
const s = vi.hoisted(() => ({
  createAccount: vi.fn(),
  getTokenPrice: vi.fn(),
  listTokenCatalogue: vi.fn(),
  listFiatOptions: vi.fn(),
  portfolio: { selectedId: "p1", defaultId: "p1" },
}));

vi.mock("@/lib/server/accounts", () => ({
  createAccount: s.createAccount,
  replaceAccountCredentials: vi.fn(),
}));
vi.mock("@/lib/server/tokens", () => ({
  getTokenPrice: s.getTokenPrice,
  listTokenCatalogue: s.listTokenCatalogue,
  listFiatOptions: s.listFiatOptions,
  listTokens: vi.fn().mockResolvedValue([]),
  refreshTokenPrices: vi.fn().mockResolvedValue([]),
  getTokenEnrichment: vi.fn(),
}));
vi.mock("@/lib/hooks/use-portfolio", () => ({
  usePortfolio: () => ({ ...s.portfolio, portfolios: [], select: vi.fn() }),
}));

const { AccountForm } = await import("@/components/account-fields");

const ta = messages.en.Accounts;
const ti = messages.en.Inputs;

const EXCHANGE_SPECS: InputSpec[] = [
  { key: "apiKey", type: "semi", label: "API Key" },
  { key: "apiSecret", type: "secret", label: "API Secret" },
];
const BTC_SPECS: InputSpec[] = [
  {
    key: "addressOrXpub",
    type: "public",
    label: "Bitcoin address or xpub",
    desc: "address (1…/3…/bc1…) or xpub/ypub/zpub",
  },
];

function mount(connectorId: string, specs: InputSpec[] = []) {
  const onDone = vi.fn();
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const utils = render(
    <QueryClientProvider client={client}>
      <IntlProvider locale="en" messages={messages.en} timeZone="UTC">
        <AccountForm connectorId={connectorId as ConnectorId} specs={specs} onDone={onDone} />
      </IntlProvider>
    </QueryClientProvider>,
  );
  const field = (id: string) => utils.container.querySelector(`#${id}`) as HTMLInputElement;
  const set = (id: string, value: string) => fireEvent.change(field(id), { target: { value } });
  const submit = () => fireEvent.submit(utils.container.querySelector("form") as HTMLFormElement);
  const submitBtn = () =>
    utils.container.querySelector('button[type="submit"]') as HTMLButtonElement;
  const button = (text: string) =>
    [...utils.container.querySelectorAll("button")].find(
      (b) => b.textContent?.trim() === text,
    ) as HTMLButtonElement;
  const sent = () => s.createAccount.mock.calls.at(-1)?.[0].data;
  const text = () => utils.container.textContent ?? "";
  return { ...utils, onDone, field, set, submit, submitBtn, button, sent, text };
}

beforeEach(() => {
  vi.clearAllMocks();
  s.portfolio.selectedId = "p1";
  s.portfolio.defaultId = "p1";
  s.createAccount.mockResolvedValue({ id: "acc_new" });
  s.listFiatOptions.mockResolvedValue([]);
});

describe("AccountForm — generic fields", () => {
  it("renders from specs: secret is a password field that blocks login autofill", () => {
    const { field } = mount("binance", EXCHANGE_SPECS);
    expect(field("add-apiKey").type).toBe("text");
    expect(field("add-apiSecret").type).toBe("password");
    expect(field("add-apiSecret").autocomplete).toBe("new-password");
  });

  it("submit → createAccount(connector, name, raw fields); no portfolioId on the default portfolio; onDone(new id)", async () => {
    const { set, submit, onDone } = mount("binance", EXCHANGE_SPECS);
    set("add-label", "Main CEX");
    set("add-apiKey", "k123");
    set("add-apiSecret", "s456");
    submit();
    await waitFor(() => expect(onDone).toHaveBeenCalledWith("acc_new"));
    expect(s.createAccount).toHaveBeenCalledWith({
      data: {
        connectorId: "binance",
        label: "Main CEX",
        values: { apiKey: "k123", apiSecret: "s456" },
        portfolioId: undefined,
      },
    });
  });

  it("viewing a non-default portfolio → new account lands there", async () => {
    s.portfolio.selectedId = "p2";
    const { set, submit, sent } = mount("binance", EXCHANGE_SPECS);
    set("add-label", "x");
    submit();
    await waitFor(() => expect(s.createAccount).toHaveBeenCalled());
    expect(sent().portfolioId).toBe("p2");
  });

  it("server rejects → shows the reason verbatim, no onDone", async () => {
    s.createAccount.mockRejectedValue(new Error("Invalid API key"));
    const { set, submit, text, onDone } = mount("binance", EXCHANGE_SPECS);
    set("add-label", "x");
    submit();
    await waitFor(() => expect(text()).toContain("Invalid API key"));
    expect(onDone).not.toHaveBeenCalled();
  });

  it("submit button disabled while in flight", async () => {
    s.createAccount.mockImplementation(() => new Promise(() => {}));
    const { set, submit, submitBtn } = mount("binance", EXCHANGE_SPECS);
    set("add-label", "x");
    expect(submitBtn().disabled).toBe(false);
    submit();
    await waitFor(() => expect(submitBtn().disabled).toBe(true));
  });

  it("name placeholder differs for wallet and manual accounts", () => {
    expect(mount("binance", EXCHANGE_SPECS).field("add-label").placeholder).toBe(
      ta.walletLabelPlaceholder,
    );
  });
});

describe("AccountForm — Bitcoin", () => {
  it("plain address → no address-type field, submits only the address", async () => {
    const { set, submit, text, sent } = mount("bitcoin", BTC_SPECS);
    set("add-label", "cold");
    set("add-addressOrXpub", "bc1qexample");
    expect(text()).not.toContain(ti["Address type"]);
    submit();
    await waitFor(() => expect(s.createAccount).toHaveBeenCalled());
    expect(sent().values).toEqual({ addressOrXpub: "bc1qexample" });
  });

  it("bare xpub → type dropdown defaults to Native; picking Taproot is submitted", async () => {
    const { set, submit, sent, container } = mount("bitcoin", BTC_SPECS);
    set("add-label", "hw");
    set("add-addressOrXpub", "xpub6ABC");
    const trigger = container.querySelector('[aria-haspopup="listbox"]') as HTMLElement;
    expect(trigger.textContent).toContain(`${ti["Native SegWit"]} · bc1q…`);

    fireEvent.click(trigger);
    const taproot = [...document.querySelectorAll('[role="option"]')].find((o) =>
      o.textContent?.includes(ti.Taproot),
    ) as HTMLElement;
    fireEvent.click(taproot);
    submit();
    await waitFor(() => expect(s.createAccount).toHaveBeenCalled());
    expect(sent().values).toEqual({ addressOrXpub: "xpub6ABC", scriptType: "taproot" });
  });

  it("bare xpub without a pick → submits default native", async () => {
    const { set, submit, sent } = mount("bitcoin", BTC_SPECS);
    set("add-label", "hw");
    set("add-addressOrXpub", "xpub6ABC");
    submit();
    await waitFor(() => expect(s.createAccount).toHaveBeenCalled());
    expect(sent().values).toEqual({ addressOrXpub: "xpub6ABC", scriptType: "native" });
  });

  it("ypub / zpub → shows the inferred type read-only, no scriptType", async () => {
    const { set, submit, sent, text, container } = mount("bitcoin", BTC_SPECS);
    set("add-label", "hw");
    set("add-addressOrXpub", "ypub6ABC");
    expect(text()).toContain(`${ti["Nested SegWit"]} · 3…`);
    expect(container.querySelector('[aria-haspopup="listbox"]')).toBeNull();

    set("add-addressOrXpub", "zpub6ABC");
    expect(text()).toContain(`${ti["Native SegWit"]} · bc1q…`);
    submit();
    await waitFor(() => expect(s.createAccount).toHaveBeenCalled());
    expect(sent().values).toEqual({ addressOrXpub: "zpub6ABC" });
  });

  it("switching from xpub back to an address drops the old scriptType", async () => {
    const { set, submit, sent } = mount("bitcoin", BTC_SPECS);
    set("add-label", "hw");
    set("add-addressOrXpub", "xpub6ABC");
    set("add-addressOrXpub", "bc1qexample");
    submit();
    await waitFor(() => expect(s.createAccount).toHaveBeenCalled());
    expect(sent().values).toEqual({ addressOrXpub: "bc1qexample" });
  });
});

describe("AccountForm — manual", () => {
  const BTC: TokenOption = {
    ticket: "tk:btc",
    symbol: "btc",
    name: "Bitcoin",
    rank: 1,
    price: 60000,
    asOf: Date.now(),
  };
  const NOPRICE: TokenOption = {
    ticket: "tk:obscure",
    symbol: "obs",
    name: "Obscure",
    asOf: Date.now(),
  };

  async function pick(m: ReturnType<typeof mount>, name: string) {
    fireEvent.click(m.button(ta.searchTokenPlaceholder));
    await waitFor(() =>
      expect(
        [...m.container.querySelectorAll("button[data-index]")].some((b) =>
          b.textContent?.includes(name),
        ),
      ).toBe(true),
    );
    const row = [...m.container.querySelectorAll("button[data-index]")].find((b) =>
      b.textContent?.includes(name),
    ) as HTMLElement;
    fireEvent.click(row);
  }

  const tokensSent = (m: ReturnType<typeof mount>) => JSON.parse(m.sent().values.tokens);

  it("picking a token reuses the dropdown's price (no refetch); submits symbol + ref + amount + price", async () => {
    s.listTokenCatalogue.mockResolvedValue([BTC]);
    const m = mount("manual");
    expect(m.field("add-label").placeholder).toBe(ta.manualLabelPlaceholder);
    await pick(m, "Bitcoin");
    await waitFor(() => expect(m.field("m-price").value).toBe("60000"));
    expect(s.getTokenPrice).not.toHaveBeenCalled();

    m.set("add-label", "stash");
    m.set("m-amount", "0.5");
    m.submit();
    await waitFor(() => expect(s.createAccount).toHaveBeenCalled());
    expect(m.sent().connectorId).toBe("manual");
    expect(tokensSent(m)).toEqual([
      { symbol: "BTC", unitPrice: "60000", amount: "0.5", ticket: "tk:btc" },
    ]);
  });

  it("picked token has no price in the dropdown → fetches once and fills the price", async () => {
    s.listTokenCatalogue.mockResolvedValue([NOPRICE]);
    s.getTokenPrice.mockResolvedValue({ unitPrice: 1.23 });
    const m = mount("manual");
    await pick(m, "Obscure");
    await waitFor(() => expect(m.field("m-price").value).toBe("1.23"));
    expect(s.getTokenPrice).toHaveBeenCalledWith({ data: { ticket: "tk:obscure" } });
  });

  it("shows 'fetching price' while in flight; a price arriving after switching to manual entry is ignored", async () => {
    s.listTokenCatalogue.mockResolvedValue([NOPRICE]);
    let resolve: (v: { unitPrice: number }) => void = () => {};
    s.getTokenPrice.mockImplementation(() => new Promise((r) => (resolve = r)));
    const m = mount("manual");
    await pick(m, "Obscure");
    await waitFor(() => expect(m.text()).toContain(ta.fetchingPrice));

    fireEvent.click(m.button(ta.enterManually));
    expect(m.text()).not.toContain(ta.fetchingPrice);
    resolve({ unitPrice: 9.99 });
    await new Promise((r) => setTimeout(r, 0));
    expect(m.field("m-price").value).toBe("");
  });

  it("switching to manual symbol clears price and ref; switching back to search clears the symbol too", async () => {
    s.listTokenCatalogue.mockResolvedValue([BTC]);
    const m = mount("manual");
    await pick(m, "Bitcoin");
    await waitFor(() => expect(m.field("m-price").value).toBe("60000"));

    fireEvent.click(m.button(ta.enterManually));
    // The manual input keeps the symbol; price is cleared (custom assets have no market price).
    expect(m.field("m-token").value).toBe("BTC");
    expect(m.field("m-price").value).toBe("");

    m.set("m-token", "MYCOIN");
    m.set("m-price", "2");
    m.set("m-amount", "10");
    m.set("add-label", "x");
    m.submit();
    await waitFor(() => expect(s.createAccount).toHaveBeenCalled());
    expect(tokensSent(m)).toEqual([{ symbol: "MYCOIN", unitPrice: "2", amount: "10" }]);

    fireEvent.click(m.button(ta.searchInstead));
    expect(m.field("m-token")).toBeNull();
    expect(m.field("m-price").value).toBe("");
  });

  it("clearing the picked token while a price is in flight → the late price is not filled in", async () => {
    s.listTokenCatalogue.mockResolvedValue([NOPRICE]);
    let resolve: (v: { unitPrice: number }) => void = () => {};
    s.getTokenPrice.mockImplementation(() => new Promise((r) => (resolve = r)));
    const m = mount("manual");
    await pick(m, "Obscure");
    await waitFor(() => expect(s.getTokenPrice).toHaveBeenCalled());

    const trigger = [...m.container.querySelectorAll("button")].find((b) =>
      b.textContent?.includes("Obscure"),
    ) as HTMLElement;
    fireEvent.click(trigger.querySelector("svg:last-child") as Element);
    resolve({ unitPrice: 9.99 });
    await new Promise((r) => setTimeout(r, 0));
    expect(m.field("m-price").value).toBe("");
  });

  it("clearing the picked token clears symbol, price and ref together", async () => {
    s.listTokenCatalogue.mockResolvedValue([BTC]);
    const m = mount("manual");
    await pick(m, "Bitcoin");
    await waitFor(() => expect(m.field("m-price").value).toBe("60000"));

    // The × on the right of the collapsed trigger.
    const trigger = [...m.container.querySelectorAll("button")].find((b) =>
      b.textContent?.includes("Bitcoin"),
    ) as HTMLElement;
    fireEvent.click(trigger.querySelector("svg:last-child") as Element);
    expect(m.field("m-price").value).toBe("");

    m.set("m-amount", "1");
    m.set("add-label", "x");
    m.submit();
    await waitFor(() => expect(s.createAccount).toHaveBeenCalled());
    expect(tokensSent(m)).toEqual([{ symbol: "", unitPrice: "", amount: "1" }]);
  });
});
