import type { ConnectorId } from "@folio/connectors";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, waitFor } from "@testing-library/react";
import { IntlProvider } from "use-intl";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TokenOption } from "@/lib/core/token-model";
import { messages } from "@/lib/i18n/messages";
import type { InputSpec } from "@/lib/server/creds";

// 加账户表单(AccountForm)。三条分支各有自己的录入规则,最后都汇成同一句 createAccount:
// · 通用(交易所 / 链上):按 specs 渲染,secret 是密码框,填什么原样交上去;
// · Bitcoin:只有**裸 xpub** 才要用户选脚本类型(默认 Native);ypub/zpub 只读显示推断结果、不带 scriptType;
//   普通地址没有这一栏;
// · 手记:选币 → 代号 + 票 + 单价(下拉里正显示的价,没有才回源现取)序列化成 `values.tokens`;
//   找不到的币转手填代号,单价清空、票不带。
// 另外:落在当前选中的组合(看默认时不传);失败把服务端的话原样显示;在飞时按钮禁用。
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

describe("AccountForm — 通用字段", () => {
  it("按 specs 渲染:secret 是密码框且不让浏览器回填登录密码", () => {
    const { field } = mount("binance", EXCHANGE_SPECS);
    expect(field("add-apiKey").type).toBe("text");
    expect(field("add-apiSecret").type).toBe("password");
    expect(field("add-apiSecret").autocomplete).toBe("new-password");
  });

  it("提交 → createAccount(connector, 名字, 原样字段);看默认组合时不带 portfolioId;成功 onDone(新 id)", async () => {
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

  it("正看着非默认组合 → 新账户落到那个组合", async () => {
    s.portfolio.selectedId = "p2";
    const { set, submit, sent } = mount("binance", EXCHANGE_SPECS);
    set("add-label", "x");
    submit();
    await waitFor(() => expect(s.createAccount).toHaveBeenCalled());
    expect(sent().portfolioId).toBe("p2");
  });

  it("服务端拒绝 → 原样显示原因,不 onDone", async () => {
    s.createAccount.mockRejectedValue(new Error("Invalid API key"));
    const { set, submit, text, onDone } = mount("binance", EXCHANGE_SPECS);
    set("add-label", "x");
    submit();
    await waitFor(() => expect(text()).toContain("Invalid API key"));
    expect(onDone).not.toHaveBeenCalled();
  });

  it("在飞时提交钮禁用", async () => {
    s.createAccount.mockImplementation(() => new Promise(() => {}));
    const { set, submit, submitBtn } = mount("binance", EXCHANGE_SPECS);
    set("add-label", "x");
    expect(submitBtn().disabled).toBe(false);
    submit();
    await waitFor(() => expect(submitBtn().disabled).toBe(true));
  });

  it("名字框的占位文案:钱包类与手记类不同", () => {
    expect(mount("binance", EXCHANGE_SPECS).field("add-label").placeholder).toBe(
      ta.walletLabelPlaceholder,
    );
  });
});

describe("AccountForm — Bitcoin", () => {
  it("普通地址 → 没有地址类型这一栏,提交只带地址", async () => {
    const { set, submit, text, sent } = mount("bitcoin", BTC_SPECS);
    set("add-label", "cold");
    set("add-addressOrXpub", "bc1qexample");
    expect(text()).not.toContain(ti["Address type"]);
    submit();
    await waitFor(() => expect(s.createAccount).toHaveBeenCalled());
    expect(sent().values).toEqual({ addressOrXpub: "bc1qexample" });
  });

  it("裸 xpub → 出现类型下拉,默认 Native;改选 Taproot 后随提交带上", async () => {
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

  it("裸 xpub 不改选 → 带默认 native", async () => {
    const { set, submit, sent } = mount("bitcoin", BTC_SPECS);
    set("add-label", "hw");
    set("add-addressOrXpub", "xpub6ABC");
    submit();
    await waitFor(() => expect(s.createAccount).toHaveBeenCalled());
    expect(sent().values).toEqual({ addressOrXpub: "xpub6ABC", scriptType: "native" });
  });

  it("ypub / zpub → 只读显示推断出的类型,不带 scriptType", async () => {
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

  it("xpub 改回普通地址 → 之前的 scriptType 不残留", async () => {
    const { set, submit, sent } = mount("bitcoin", BTC_SPECS);
    set("add-label", "hw");
    set("add-addressOrXpub", "xpub6ABC");
    set("add-addressOrXpub", "bc1qexample");
    submit();
    await waitFor(() => expect(s.createAccount).toHaveBeenCalled());
    expect(sent().values).toEqual({ addressOrXpub: "bc1qexample" });
  });
});

describe("AccountForm — 手记", () => {
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

  it("选币 → 用下拉里显示的价回填单价(不再回源),提交带代号 + 票 + 数量 + 单价", async () => {
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

  it("选的币下拉里没价 → 回源现取一次填进单价", async () => {
    s.listTokenCatalogue.mockResolvedValue([NOPRICE]);
    s.getTokenPrice.mockResolvedValue({ unitPrice: 1.23 });
    const m = mount("manual");
    await pick(m, "Obscure");
    await waitFor(() => expect(m.field("m-price").value).toBe("1.23"));
    expect(s.getTokenPrice).toHaveBeenCalledWith({ data: { ticket: "tk:obscure" } });
  });

  it("取价在飞时提示「正在取价」,并且转手填后回来的价不会把单价填上", async () => {
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

  it("转手填代号 → 单价清空、不带票;再转回搜索 → 代号也清掉", async () => {
    s.listTokenCatalogue.mockResolvedValue([BTC]);
    const m = mount("manual");
    await pick(m, "Bitcoin");
    await waitFor(() => expect(m.field("m-price").value).toBe("60000"));

    fireEvent.click(m.button(ta.enterManually));
    // 手填框带着刚才的代号,单价清空(自定义资产没有市价)。
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

  it("取价在飞时清掉已选币 → 回来的价不再填进单价框", async () => {
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

  it("清掉已选币 → 代号 / 单价 / 票一起清", async () => {
    s.listTokenCatalogue.mockResolvedValue([BTC]);
    const m = mount("manual");
    await pick(m, "Bitcoin");
    await waitFor(() => expect(m.field("m-price").value).toBe("60000"));

    // 收起态触发器右侧的 ×。
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
