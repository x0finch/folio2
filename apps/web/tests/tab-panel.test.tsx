import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TabPanel } from "../src/components/tab-panel";

// 页内 tab 的转场(片6)。jsdom 里量不到动画本身,能量的是两件正经决定:
//   ① 减少动态效果时**整层跳过** —— 不包 motion,不是「淡得慢一点」;
//   ② 内容照常渲染(包一层不能把子树弄丢)。
// 「淡入淡出好不好看」留真机。

const reduced = vi.hoisted(() => ({ value: false }));
vi.mock("motion/react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("motion/react")>();
  return { ...actual, useReducedMotion: () => reduced.value };
});

afterEach(() => {
  cleanup();
  reduced.value = false;
});

describe("<TabPanel>", () => {
  it("正常态:内容在,并且外面包了一层动画容器", () => {
    const { container } = render(
      <TabPanel tabKey="tokens">
        <p>内容</p>
      </TabPanel>,
    );
    expect(screen.getByText("内容")).toBeTruthy();
    // motion.div 会带上 style(opacity 由动画驱动)→ 包裹层存在。
    expect(container.firstElementChild?.tagName).toBe("DIV");
    expect(container.querySelector("p")?.parentElement).toBe(container.firstElementChild);
  });

  it("减少动态效果:不包任何容器,内容直接是根", () => {
    reduced.value = true;
    const { container } = render(
      <TabPanel tabKey="tokens">
        <p>内容</p>
      </TabPanel>,
    );
    expect(screen.getByText("内容")).toBeTruthy();
    expect(container.firstElementChild?.tagName).toBe("P");
  });
});
