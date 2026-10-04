import { cleanup, render, screen, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { IntlProvider } from "use-intl";
import { afterEach, describe, expect, it } from "vitest";
import type { PerpPositionView, PerpView } from "@/lib/core/account-view";
import { BalancePrivacyProvider } from "@/lib/hooks/use-balance-privacy";
import { messages } from "@/lib/i18n/messages";
import {
  PerpPositions,
  PerpPositionsList,
  type PerpSectionItem,
} from "@/routes/_authed/-home/holdings/perp";

// 永续持仓(首页「永续」tab 与账户抽屉共用)屏幕上写的是什么:
//   · 账户权益条:权益 / 未实现盈亏(各仓位相加)/ 保证金占用% / 可提 / 名义 / 账户杠杆;权益为 0 时
//     两个比率不出现(不除零)
//   · 多账户按权益降序;账户头用平台名 + `@账户名`,没平台就只写账户名
//   · 仓位行:`3x Long` 方向 pill、数量取绝对值;有强平价 → 风险环(明细里的余量 / 开仓 / 标记 / 强平),
//     没有 → 降级成「Entry $x」文字
//   · 风险环的填充:危险态至少一小段、穿仓给满环
//   · 隐私:钱(权益、盈亏、可提、名义、数量、已用保证金)被遮;比率、市场价不遮
// beUI hover Popover 关着时也把明细渲染在 DOM 里,所以明细文字直接可断。

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

const pos = (over: Partial<PerpPositionView> = {}): PerpPositionView => ({
  coin: "BTC",
  side: "long",
  entryPx: 50_000,
  positionValue: 6_000,
  unrealizedPnl: 1_000,
  leverage: 3,
  leverageType: "cross",
  liquidationPx: 40_000,
  marginUsed: 200,
  size: 0.1,
  ...over,
});

const ethShortNoLiq = pos({
  coin: "ETH",
  side: "short",
  entryPx: 2_000,
  positionValue: 2_000,
  unrealizedPnl: -50,
  leverage: undefined,
  leverageType: undefined,
  liquidationPx: null,
  marginUsed: 100,
  size: -1,
});

const view = (over: Partial<PerpView> = {}): PerpView => ({
  equity: { accountValue: 1_000, withdrawable: 400, totalMarginUsed: 250, totalNtlPos: 3_000 },
  positions: [pos(), ethShortNoLiq],
  ...over,
});

// Stat:label 与值是相邻两个 div。按 label 找到它,取它的兄弟。
const stat = (label: string) => screen.getByText(label).nextElementSibling?.textContent;

describe("账户权益条", () => {
  it("六个数:权益、各仓相加的 uPnL、保证金占用%、可提、名义、账户杠杆", () => {
    wrap(<PerpPositions view={view()} />);
    expect(stat("Equity")).toBe("$1,000.00");
    expect(stat("uPnL")).toBe("+$950.00"); // 1000 + (−50)
    expect(stat("Margin usage")).toBe("25%"); // 250 / 1000
    expect(stat("Withdrawable")).toBe("$400.00");
    expect(stat("Notional")).toBe("$3,000.00");
    expect(stat("Acct. leverage")).toBe("3.00x"); // 3000 / 1000
  });

  it("权益为 0 → 不出保证金占用与账户杠杆(不除零)", () => {
    wrap(
      <PerpPositions
        view={view({
          equity: { accountValue: 0, withdrawable: 0, totalMarginUsed: 10, totalNtlPos: 100 },
        })}
      />,
    );
    expect(screen.queryByText("Margin usage")).toBeNull();
    expect(screen.queryByText("Acct. leverage")).toBeNull();
    expect(stat("Equity")).toBe("$0.00");
  });

  it("没有权益行 → 整条不出,仓位照常", () => {
    wrap(<PerpPositions view={view({ equity: null })} />);
    expect(screen.queryByText("Equity")).toBeNull();
    expect(screen.getByText("BTC", { exact: false })).toBeTruthy();
  });

  it("单账户分区默认有节头,hideHeader 时省掉", () => {
    const a = wrap(<PerpPositions view={view()} />);
    expect(screen.getByText("Perp positions")).toBeTruthy();
    a.unmount();
    wrap(<PerpPositions view={view()} hideHeader />);
    expect(screen.queryByText("Perp positions")).toBeNull();
  });
});

describe("仓位行", () => {
  it("方向 pill 带杠杆、数量取绝对值;没杠杆就只写方向", () => {
    const { container } = wrap(<PerpPositions view={view()} hideHeader />);
    const text = container.textContent ?? "";
    expect(text).toContain("3x Long");
    expect(text).toContain("0.1 BTC");
    expect(text).toContain("Short");
    expect(text).not.toContain("x Short");
    expect(text).toContain("1 ETH"); // size = −1 → 1
    expect(text).not.toContain("-1 ETH");
  });

  it("有强平价 → 风险环,明细里是保证金模式 / 已用 / 余量 / 开仓 / 标记 / 强平", () => {
    wrap(<PerpPositions view={view({ positions: [pos()] })} hideHeader />);
    const ring = screen.getByRole("button", { name: "Safety margin" });
    expect(ring).toBeTruthy();
    // 明细:mark = 6000 / 0.1 = 60,000;余量 = (60000 − 40000) / 60000 ≈ 33%
    const detail = (label: string) =>
      screen.getAllByText(label).at(-1)?.nextElementSibling?.textContent;
    expect(detail("Margin mode")).toBe("Cross");
    expect(detail("Margin used")).toBe("$200.00");
    expect(detail("Safety margin")).toBe("33%");
    expect(detail("Mark")).toBe("$60,000.00");
    expect(detail("Liq.")).toBe("$40,000.00");
    expect(detail("Entry")).toBe("$50,000.00");
  });

  it("没有强平价 → 不画环,降级成「Entry $x」", () => {
    const { container } = wrap(
      <PerpPositions view={view({ positions: [ethShortNoLiq] })} hideHeader />,
    );
    expect(screen.queryByRole("button", { name: "Safety margin" })).toBeNull();
    expect(container.textContent).toContain("Entry $2,000.00");
  });

  it("没有保证金模式 → 明细里不出那一行", () => {
    wrap(
      <PerpPositions view={view({ positions: [pos({ leverageType: undefined })] })} hideHeader />,
    );
    expect(screen.queryByText("Margin mode")).toBeNull();
  });
});

// 环的彩弧 = 第二个 circle 的 strokeDasharray「弧长 周长」→ 弧长 / 周长 = 填充比例。
function ringFill(container: HTMLElement): number {
  const arc = container.querySelectorAll("svg circle")[1];
  const [len, circ] = (arc?.getAttribute("stroke-dasharray") ?? "").split(" ").map(Number);
  return len / circ;
}

describe("风险环的填充", () => {
  // 多头 entry 100 / 强平 90,数量 1 → 标记价 = positionValue。
  const at = (mark: number) =>
    pos({ entryPx: 100, liquidationPx: 90, size: 1, positionValue: mark, leverageType: undefined });

  it("警告区(余量 10%)→ 按余量 / 25% 填,不封顶", () => {
    const { container } = wrap(<PerpPositions view={view({ positions: [at(100)] })} hideHeader />);
    expect(ringFill(container)).toBeCloseTo(0.4, 5);
  });

  it("危险但未穿仓(余量约 1%)→ 至少留一小段可见的红弧", () => {
    const { container } = wrap(<PerpPositions view={view({ positions: [at(91)] })} hideHeader />);
    expect(ringFill(container)).toBeCloseTo(0.08, 5);
  });

  it("已越过强平价 → 满环(终态),余量写 0%", () => {
    const { container } = wrap(<PerpPositions view={view({ positions: [at(85)] })} hideHeader />);
    expect(ringFill(container)).toBeCloseTo(1, 5);
    expect(screen.getAllByText("Safety margin").at(-1)?.nextElementSibling?.textContent).toBe("0%");
  });
});

describe("多账户列表(首页「永续」tab)", () => {
  const item = (
    id: string,
    equity: number,
    over: Partial<PerpSectionItem> = {},
  ): PerpSectionItem => ({
    id,
    view: view({
      equity: { accountValue: equity, withdrawable: 0, totalMarginUsed: 0, totalNtlPos: 0 },
      positions: [],
    }),
    ...over,
  });

  it("按权益降序排,没权益的垫底", () => {
    const { container } = wrap(
      <PerpPositionsList
        items={[
          item("a", 100, { accountLabel: "Small" }),
          { ...item("b", 0, { accountLabel: "None" }), view: { equity: null, positions: [] } },
          item("c", 900, { accountLabel: "Big" }),
        ]}
      />,
    );
    const heads = [...container.querySelectorAll(".truncate.font-medium")].map(
      (e) => e.textContent,
    );
    expect(heads).toEqual(["Big", "Small", "None"]);
  });

  it("有平台 → 主行平台名、副行 @账户名;没平台 → 主行就是账户名", () => {
    wrap(
      <PerpPositionsList
        items={[
          item("a", 900, { platform: { name: "Hyperliquid" }, accountLabel: "Main" }),
          item("b", 100, { accountLabel: "Solo" }),
        ]}
      />,
    );
    expect(screen.getByText("Hyperliquid")).toBeTruthy();
    expect(screen.getByText("@Main")).toBeTruthy();
    expect(screen.getByText("Solo")).toBeTruthy();
    expect(screen.queryByText("@Solo")).toBeNull();
  });
});

describe("隐私", () => {
  it("开着 → 钱都被遮;保证金占用、账户杠杆、方向、开仓价不遮", () => {
    const { container } = wrap(<PerpPositions view={view()} hideHeader />, true);
    const masked = screen
      .getAllByRole("button", { name: /balance hidden/i })
      .map((m) => m.textContent);
    expect(masked).toEqual(
      expect.arrayContaining(["$1,000.00", "+$950.00", "$400.00", "$3,000.00", "0.1", "$200.00"]),
    );
    expect(stat("Margin usage")).toBe("25%");
    expect(stat("Acct. leverage")).toBe("3.00x");
    expect(container.textContent).toContain("Entry $2,000.00");
    // 未遮的那份「Entry $x」不在任何遮罩里。
    for (const m of screen.getAllByRole("button", { name: /balance hidden/i })) {
      expect(within(m).queryByText(/Entry/)).toBeNull();
    }
  });
});
