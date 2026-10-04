import { cleanup, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { IntlProvider } from "use-intl";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HomeTabStripView } from "@/lib/core/portfolio";
import { messages } from "@/lib/i18n/messages";

// 首页的装配(Overview):三个岛各有自己的挂起 / 失败边界,外壳(同步条)不跟着塌。
//   · 同步条恒在,且首页打开「数据过期自动补一轮」
//   · 组合里没有账户 → tab 条那格换成「No accounts yet. Add one.」,链接去账户页
//   · 有账户 → 渲染 tab 条
//   · 某个岛在取数 → 只有那一格是骨架;某个岛失败 → 只有那一格写「Couldn't load this.」
//   · 页内 tab / 代币抽屉状态的 Provider 挂在这一层(岛里能读到)
// 三个岛、同步条、路由 Link 都换成替身:这里只看这一层怎么排、怎么兜。

const h = vi.hoisted(() => ({
  strip: { hasAccounts: true, hasPerps: false, hasDefi: false, pins: [] } as HomeTabStripView,
  hero: { current: (): ReactNode => "HERO" },
  holdings: { current: (): ReactNode => "HOLDINGS" },
  headerSyncProps: [] as unknown[],
  linkProps: [] as unknown[],
}));

vi.mock("@tanstack/react-router", () => ({
  Link: (p: { to: string; params: unknown; children: ReactNode }) => {
    h.linkProps.push({ to: p.to, params: p.params });
    return <a href="#accounts">{p.children}</a>;
  },
}));
vi.mock("@/lib/hooks/use-portfolio", () => ({ usePortfolio: () => ({ selectedId: "p1" }) }));
vi.mock("@/lib/hooks/use-home-tab-strip", () => ({ useHomeTabStrip: () => h.strip }));
vi.mock("@/routes/_authed/-home/header-sync", () => ({
  HeaderSync: (props: unknown) => {
    h.headerSyncProps.push(props);
    return <div>SYNC</div>;
  },
}));
vi.mock("@/routes/_authed/-home/hero", () => ({ HeroIsland: () => <>{h.hero.current()}</> }));
vi.mock("@/routes/_authed/-home/holdings", () => ({
  HoldingsIsland: () => <>{h.holdings.current()}</>,
}));
vi.mock("@/routes/_authed/-home/tab", async () => {
  const { useHomeViewState } = await import("@/routes/_authed/-home/view-state");
  return {
    // 读一下页内状态:Provider 没挂在这层的话这里会抛。
    TabStripIsland: () => <>TABS:{useHomeViewState().tab}</>,
  };
});

const { Overview } = await import("@/routes/_authed/-home");

beforeEach(() => {
  h.strip = { hasAccounts: true, hasPerps: false, hasDefi: false, pins: [] };
  h.hero.current = () => "HERO";
  h.holdings.current = () => "HOLDINGS";
  h.headerSyncProps = [];
  h.linkProps = [];
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function mount() {
  return render(
    <IntlProvider locale="en" messages={messages.en} timeZone="UTC">
      <Overview />
    </IntlProvider>,
  );
}

describe("首页装配", () => {
  it("有账户 → 同步条 + hero + tab 条 + 持仓;首页打开过期自动补同步", () => {
    const { container } = mount();
    expect(container.textContent).toBe("SYNCHEROTABS:tokensHOLDINGS");
    expect(h.headerSyncProps.at(-1)).toEqual({ autoSyncWhenStale: true });
  });

  it("没有账户 → tab 条那格换成「No accounts yet. Add one.」,链接去账户页", () => {
    h.strip = { ...h.strip, hasAccounts: false };
    mount();
    expect(screen.queryByText(/TABS/)).toBeNull();
    expect(screen.getByText(/No accounts yet\./)).toBeTruthy();
    expect(screen.getByRole("link", { name: "Add one" })).toBeTruthy();
    expect(h.linkProps.at(-1)).toEqual({ to: "/{-$page}", params: { page: "accounts" } });
  });

  it("某个岛还在取数 → 只有那一格是骨架,其它照常", () => {
    h.hero.current = () => {
      throw new Promise(() => {});
    };
    const { container } = mount();
    expect(container.textContent).toBe("SYNCTABS:tokensHOLDINGS");
    expect(container.querySelector("[data-slot=skeleton]")).toBeTruthy();
  });

  it("持仓岛在取数 → 骨架行,hero 与 tab 条不受影响", () => {
    h.holdings.current = () => {
      throw new Promise(() => {});
    };
    const { container } = mount();
    expect(container.textContent).toBe("SYNCHEROTABS:tokens");
    expect(container.querySelectorAll("[data-slot=skeleton]").length).toBeGreaterThan(1);
  });

  it("某个岛失败 → 只有那一格写「Couldn't load this.」,同步条与其它岛不塌", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    h.holdings.current = () => {
      throw new Error("boom");
    };
    const { container } = mount();
    expect(screen.getByText("Couldn't load this.")).toBeTruthy();
    expect(container.textContent).toContain("SYNCHEROTABS:tokens");
  });

  it("hero 失败 → 那一格写「Couldn't load this.」,tab 条与持仓照常", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    h.hero.current = () => {
      throw new Error("boom");
    };
    const { container } = mount();
    expect(container.textContent).toBe("SYNCCouldn't load this.TABS:tokensHOLDINGS");
  });
});
