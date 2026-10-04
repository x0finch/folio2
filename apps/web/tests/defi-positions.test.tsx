import { cleanup, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { IntlProvider } from "use-intl";
import { afterEach, describe, expect, it } from "vitest";
import type { DefiGroup, DefiRow } from "@/lib/core/account-view";
import { BalancePrivacyProvider } from "@/lib/hooks/use-balance-privacy";
import { messages } from "@/lib/i18n/messages";
import { DefiPositions } from "@/routes/_authed/-home/holdings/defi";

// DeFi 持仓(首页「DeFi」tab 与账户抽屉共用)屏幕上写的是什么:
//   · 每协议一行:协议名 + 净小计(资产 − 负债)+ 24h 增量(算不出 → `—`,还在取 → 骨架)
//   · 构成条:按角色分段、角色名排在条上方;小角色至少占 5%(看得见),全 0 值均分
//   · hover 明细:按角色分组列出每条腿的数量与美元值,负债腿带「−」
//   · 隐私:腿的数量与美元值都遮
// beUI hover Popover 关着时也把明细渲染在 DOM 里(只是 inert),所以直接读那段 DOM。

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

// 协议行右侧 ValueDelta:第一行市值,第二行增量。
const protocolRow = (name: string) =>
  screen.getByText(name, { selector: ".truncate" }).parentElement?.parentElement as HTMLElement;
const valueLines = (name: string) =>
  [...(protocolRow(name).lastElementChild?.children ?? [])].map((e) => e.textContent);

const detail = (container: HTMLElement) => container.querySelector("[role=dialog]") as HTMLElement;

describe("协议行", () => {
  it("净小计 = 资产 − 负债;24h 增量带符号和百分比", () => {
    wrap(<DefiPositions groups={[aave]} />);
    expect(valueLines("Aave")).toEqual(["$1,224.00", "+$12.00 1.50%"]);
  });

  it("24h 算不出 → `—`,不是留白", () => {
    wrap(<DefiPositions groups={[{ ...aave, gain24h: null }]} />);
    expect(valueLines("Aave")).toEqual(["$1,224.00", "—"]);
  });

  it("24h 还在取 → 骨架,不是破折号", () => {
    wrap(<DefiPositions groups={[{ ...aave, gain24h: null }]} gainPending />);
    expect(valueLines("Aave")[1]).not.toBe("—");
    expect(protocolRow("Aave").querySelector("[data-slot=skeleton]")).toBeTruthy();
  });

  it("默认有节头;首页 tab 里 hideHeader 省掉", () => {
    const a = wrap(<DefiPositions groups={[aave]} />);
    expect(screen.getByText("DeFi positions")).toBeTruthy();
    a.unmount();
    wrap(<DefiPositions groups={[aave]} hideHeader />);
    expect(screen.queryByText("DeFi positions")).toBeNull();
  });

  it("每个协议一行", () => {
    wrap(
      <DefiPositions groups={[aave, { protocol: "Lido", rows: [row("x", "stETH", 1, 3000)] }]} />,
    );
    expect(screen.getByText("Aave", { selector: ".truncate" })).toBeTruthy();
    expect(screen.getByText("Lido", { selector: ".truncate" })).toBeTruthy();
  });
});

describe("构成条与明细", () => {
  it("条上按角色写名字;条本身以协议名为可读标签", () => {
    const { container } = wrap(<DefiPositions groups={[aave]} />);
    const labels = [...container.querySelectorAll("[data-lab]")].map((e) => e.textContent);
    expect(labels).toEqual(["deposit", "loan"]);
    expect(screen.getByRole("button", { name: "Aave" })).toBeTruthy();
  });

  it("明细按角色分组列出每条腿;负债腿的数量与金额都带「−」", () => {
    const { container } = wrap(<DefiPositions groups={[aave]} />);
    const text = detail(container).textContent ?? "";
    expect(text).toContain("843 GHO$843.00");
    expect(text).toContain("0.24 WETH$600.00");
    expect(text).toContain("−219 GHO−$219.00");
    // 角色顺序:deposit 那组在前(腿按 |usd| 降序,先出现的角色先排)。
    expect(text.indexOf("deposit")).toBeLessThan(text.indexOf("loan"));
  });

  it("小角色抬到 5% —— 不会被压成看不见的一条线", () => {
    const { container } = wrap(
      <DefiPositions
        groups={[
          {
            protocol: "Pendle",
            rows: [row("a", "PT", 1, 10_000, "deposit"), row("b", "PENDLE", 1, 1, "reward")],
          },
        ]}
      />,
    );
    const grow = [...container.querySelectorAll<HTMLElement>("[data-lab]")].map((e) =>
      Number(e.style.flexGrow),
    );
    expect(grow[1]).toBe(5);
    expect(grow[0]).toBeCloseTo(95, 5);
  });

  it("全是 0 值 → 各角色均分", () => {
    const { container } = wrap(
      <DefiPositions
        groups={[
          {
            protocol: "Dust",
            rows: [row("a", "A", 0, 0, "deposit"), row("b", "B", 0, 0, "reward")],
          },
        ]}
      />,
    );
    const grow = [...container.querySelectorAll<HTMLElement>("[data-lab]")].map((e) =>
      Number(e.style.flexGrow),
    );
    expect(grow).toEqual([50, 50]);
  });
});

describe("隐私", () => {
  it("开着 → 明细里每条腿的数量与金额都被遮", () => {
    const { container } = wrap(<DefiPositions groups={[aave]} />, true);
    const masked = [...detail(container).querySelectorAll("[role=button]")].map(
      (m) => m.textContent,
    );
    expect(masked).toEqual(["843 GHO", "$843.00", "0.24 WETH", "$600.00", "−219 GHO", "−$219.00"]);
  });
});
