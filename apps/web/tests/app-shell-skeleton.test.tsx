import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { AppShellSkeleton } from "@/components/app-shell";

// 骨架壳是服务端**唯一**渲染的东西(ADR 0049 / FOL-34),它值钱的地方只有一个:**零数据**。
// 免费档一次请求只给 10 毫秒 CPU,壳里多一次查询、多一个 provider,这一片就白做了。
//
// 所以这条测试的形状本身就是断言:**什么都不套,直接 render**。没有 IntlProvider、没有
// RouterProvider、没有 QueryClientProvider —— 谁哪天在壳里加一个 `useTranslations` /
// `useRouterState` / `useSuspenseQuery`,这里立刻炸,而不是等到线上白屏才发现。
//
// (对照:真外壳 `AppShell` 三样都要,所以它没法这么测 —— 那正是两者的分界。)
describe("<AppShellSkeleton>", () => {
  it("不套任何 provider 也渲得出来", () => {
    expect(() => render(<AppShellSkeleton />)).not.toThrow();
  });

  it("是骨架:灰条占位 + 品牌行,一个数字都没有", () => {
    const { container } = render(<AppShellSkeleton />);
    expect(container.querySelectorAll('[data-slot="skeleton"]').length).toBeGreaterThan(0);
    // 品牌行两处(桌面侧栏顶 + 移动顶栏),与真外壳同一份 <Brand>。
    expect(container.querySelectorAll("svg[aria-label='folio']").length).toBe(2);
    // 导航文案属于真外壳;骨架里那四条是灰条。这一条钉的是「壳没有偷偷把 AppShell 渲进来」。
    expect(container.textContent).not.toContain("Overview");
  });
});
