import { render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LockScreen } from "../src/components/lock-screen";

// 两层 LockScreen(ADR 0029):timeoutMs===null(永不 / 默认)→ 纯透传 children,不挂 useIdleLock。
// 反查点 = 活动监听没被注册:恒挂(旧结构)时 useIdleLock 会在 window 上装 mousemove 等,
// 这里断言「永不」下一个都没装 —— 证明整套闲置机制确实没进树,而非靠 hook 内部判 null。
describe("LockScreen 两层:永不不挂闲置机制", () => {
  beforeEach(() => localStorage.clear());
  afterEach(() => vi.restoreAllMocks());

  it("默认(永不)→ 渲染 children 且不注册活动监听", () => {
    const spy = vi.spyOn(window, "addEventListener");
    const { getByText } = render(
      <LockScreen userEmail="a@b.c">
        <span>hi</span>
      </LockScreen>,
    );
    expect(getByText("hi")).toBeTruthy();
    expect(spy.mock.calls.map((c) => c[0])).not.toContain("mousemove");
  });

  it("显式选「永不」→ 同样不注册活动监听", () => {
    localStorage.setItem("folio_lock_timeout", "never");
    const spy = vi.spyOn(window, "addEventListener");
    render(
      <LockScreen userEmail="a@b.c">
        <span>hi</span>
      </LockScreen>,
    );
    expect(spy.mock.calls.map((c) => c[0])).not.toContain("mousemove");
  });

  it("选具体档(5 分钟)→ 挂 useIdleLock,注册活动监听", () => {
    localStorage.setItem("folio_lock_timeout", "5");
    const spy = vi.spyOn(window, "addEventListener");
    render(
      <LockScreen userEmail="a@b.c">
        <span>hi</span>
      </LockScreen>,
    );
    expect(spy.mock.calls.map((c) => c[0])).toContain("mousemove");
  });
});
