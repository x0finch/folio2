import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, waitFor } from "@testing-library/react";
import { IntlProvider } from "use-intl";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TokenOption } from "@/lib/core/token-model";
import { messages } from "@/lib/i18n/messages";

// 手记选币的内联下拉。钉住用户走一遍会碰到的每一处:
// ① 收起态:有选中显示代号 + 名字,点 × 清空且不展开;
// ② 展开:按「已有 / 代币 / 现金」分组列出;敲字本地即筛,本地凑不够且 ≥2 字符才防抖问上游;
// ③ 点行 / ↓+Enter 选中 → onChange 带着**下拉里正显示的那个价**(刷来的优先)并收起;Esc / 点外面只收起;
// ④ 没结果 → 「手动输入 X」与 Enter 都走 onManual(query);一条都没有时目录挂了 → 报搜索失败;
// ⑤ 价过期的行在展开后批量补一次价,补来的价显示在行上。
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

// jsdom 没有 scrollIntoView(键盘移高亮时把那行滚进可视区用)。
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

describe("TokenCombobox — 收起态", () => {
  it("没选 → 占位提示;选了 → 大写代号 + 名字", () => {
    expect(mount().text()).toContain(ta.searchTokenPlaceholder);
    const picked = mount({ value: BTC }).text();
    expect(picked).toContain("BTC");
    expect(picked).toContain("Bitcoin");
  });

  it("点 × → onChange(null),不展开", () => {
    const { container, onChange, input } = mount({ value: BTC });
    fireEvent.click(container.querySelector("button svg:last-child") as Element);
    expect(onChange).toHaveBeenCalledWith(null);
    expect(input()).toBeNull();
  });
});

describe("TokenCombobox — 浏览与搜索", () => {
  it("展开 → 分组列出:已有 / 代币 / 现金", async () => {
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

  it("行上显示价与 24h 涨跌", async () => {
    const { open, row } = mount();
    open();
    await waitFor(() => expect(row("Bitcoin")).toBeTruthy());
    expect(row("Bitcoin").textContent).toContain("+1.50%");
    expect(row("Ethereum").textContent).toContain("-2.00%");
  });

  it("敲字 → 本地即筛", async () => {
    const { open, type, rows, row } = mount();
    open();
    await waitFor(() => expect(rows().length).toBeGreaterThan(0));
    type("ethe");
    expect(rows().map((r) => r.textContent)).toHaveLength(1);
    expect(row("Ethereum")).toBeTruthy();
  });

  it("本地凑不够 → 防抖后问一次上游,回来的结果并进列表", async () => {
    s.listTokens.mockResolvedValue([tok("pepe", "Pepe")]);
    const { open, type, row } = mount();
    open();
    await waitFor(() => expect(s.listTokenCatalogue).toHaveBeenCalled());
    // 连敲几下:中间那几个词不该各打一次上游,只认停顿后的那一个。
    type("pe");
    type("pep");
    type("pepe");
    await waitFor(() => expect(row("Pepe")).toBeTruthy());
    expect(s.listTokens).toHaveBeenCalledTimes(1);
    expect(s.listTokens).toHaveBeenCalledWith({ data: { query: "pepe" } });
  });

  it("本地命中已经够多 → 不问上游", async () => {
    const many = Array.from({ length: 10 }, (_, i) =>
      tok(`w${i}`, `Wrapped ${i}`, { rank: i + 1 }),
    );
    const { open, type, rows } = mount({}, many);
    open();
    await waitFor(() => expect(rows().length).toBeGreaterThan(0));
    type("wrapped");
    await new Promise((r) => setTimeout(r, 400)); // 超过防抖窗口
    expect(rows().length).toBeGreaterThanOrEqual(8);
    expect(s.listTokens).not.toHaveBeenCalled();
  });

  it("只敲一个字符 → 不问上游", async () => {
    const { open, type, rows } = mount();
    open();
    await waitFor(() => expect(rows().length).toBeGreaterThan(0));
    type("z");
    await new Promise((r) => setTimeout(r, 400)); // 超过防抖窗口
    expect(s.listTokens).not.toHaveBeenCalled();
  });
});

describe("TokenCombobox — 选中与收起", () => {
  it("点行 → onChange(该币,带着显示价)并收起", async () => {
    const { open, row, onChange, input } = mount();
    open();
    await waitFor(() => expect(row("Ethereum")).toBeTruthy());
    fireEvent.click(row("Ethereum"));
    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({ ticket: ETH.ticket, price: 3000 }),
    );
    expect(input()).toBeNull();
  });

  it("↓ 再 Enter → 选中第二行", async () => {
    const { open, key, rows, onChange } = mount();
    open();
    await waitFor(() => expect(rows().length).toBe(3));
    key("ArrowDown");
    key("Enter");
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ ticket: ETH.ticket }));
  });

  it("↓↓ 再 ↑ 再 Enter → 回到第二行", async () => {
    const { open, key, rows, onChange } = mount();
    open();
    await waitFor(() => expect(rows().length).toBe(3));
    key("ArrowDown");
    key("ArrowDown");
    key("ArrowUp");
    key("Enter");
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ ticket: ETH.ticket }));
  });

  it("Esc → 收起,不改选", async () => {
    const { open, key, rows, onChange, input } = mount();
    open();
    await waitFor(() => expect(rows().length).toBe(3));
    key("Escape");
    expect(input()).toBeNull();
    expect(onChange).not.toHaveBeenCalled();
  });

  it("点组件外 → 收起,不改选", async () => {
    const { open, rows, onChange, input, getByText } = mount();
    open();
    await waitFor(() => expect(rows().length).toBe(3));
    fireEvent.pointerDown(getByText("outside"));
    expect(input()).toBeNull();
    expect(onChange).not.toHaveBeenCalled();
  });
});

describe("TokenCombobox — 没结果 / 出错", () => {
  it("没结果 → 「手动输入」按钮走 onManual(query)", async () => {
    const { open, type, onManual, text, getByText } = mount();
    open();
    await waitFor(() => expect(s.listTokenCatalogue).toHaveBeenCalled());
    type("zzzz");
    await waitFor(() => expect(text()).toContain(ta.noResults));
    fireEvent.click(getByText(ta.customEntry.replace("{query}", "zzzz")));
    expect(onManual).toHaveBeenCalledWith("zzzz");
  });

  it("没结果时按 Enter → 同样走 onManual", async () => {
    const { open, type, key, onManual, text } = mount();
    open();
    await waitFor(() => expect(s.listTokenCatalogue).toHaveBeenCalled());
    type("zzzz");
    await waitFor(() => expect(text()).toContain(ta.noResults));
    key("Enter");
    expect(onManual).toHaveBeenCalledWith("zzzz");
  });

  it("目录取失败、手上一条都没有 → 报搜索失败", async () => {
    const { open, text } = mount({}, new Error("down"), []);
    open();
    await waitFor(() => expect(text()).toContain(ta.searchFailed));
  });

  it("目录取失败但还有别的可选(法币)→ 照常列出,不报错", async () => {
    const { open, text, row } = mount({}, new Error("down"));
    open();
    await waitFor(() => expect(row("US Dollar")).toBeTruthy());
    expect(text()).not.toContain(ta.searchFailed);
  });
});

describe("TokenCombobox — 展开时补价", () => {
  it("同一次打开里,补过的票不再补(哪怕那次失败了、列表又变了)", async () => {
    const stale = tok("doge", "Dogecoin", { asOf: undefined });
    s.refreshTokenPrices.mockRejectedValue(new Error("rate limited"));
    const { open, type, rows } = mount({}, [BTC, stale]);
    open();
    await waitFor(() => expect(s.refreshTokenPrices).toHaveBeenCalledTimes(1));
    type("dog");
    await waitFor(() => expect(rows()).toHaveLength(1));
    await new Promise((r) => setTimeout(r, 400)); // 等搜索词落定(刷价跟着落定才发)
    expect(s.refreshTokenPrices).toHaveBeenCalledTimes(1);
  });

  it("价过期的行 → 批量刷一次,刷来的价显示在行上、选中时带出去", async () => {
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
