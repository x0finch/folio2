import { render } from "@testing-library/react";
import type { ReactNode } from "react";
import { IntlProvider } from "use-intl";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LockScreen } from "../src/components/lock-screen";
import { messages } from "../src/lib/i18n/messages";

// 锁定态会渲染锁屏 UI(useTranslations)→ 需要 IntlProvider。未锁的用例走 children、无需它。
const withIntl = (node: ReactNode) => (
  <IntlProvider locale="en" messages={messages.en}>
    {node}
  </IntlProvider>
);

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

// 锁定时卸载 children(不只是遮罩叠加):DOM 里不留内容,懂开发的人删遮罩也看不到底下数据。
describe("LockScreen 锁定时卸载 children", () => {
  beforeEach(() => localStorage.clear());
  afterEach(() => vi.restoreAllMocks());

  it("已处于锁定(共享锁标志已置)→ children 不在 DOM,只剩锁屏", () => {
    localStorage.setItem("folio_lock_timeout", "1"); // 具体档才挂 ActiveLockScreen
    localStorage.setItem("folio_lock_locked", "1"); // 别处已锁 → 本组件初始即锁
    const { queryByText, queryByPlaceholderText } = render(
      withIntl(
        <LockScreen userEmail="a@b.c">
          <span>secret-content</span>
        </LockScreen>,
      ),
    );
    expect(queryByText("secret-content")).toBeNull(); // children 卸载,内容不进 DOM
    expect(queryByPlaceholderText(/password|密码/i)).not.toBeNull(); // 锁屏在
  });

  it("闲置到点锁(lastActive 陈旧)→ children 从 DOM 移除", () => {
    localStorage.setItem("folio_lock_timeout", "1");
    localStorage.setItem("folio_lock_last_active", String(Date.now() - 5 * 60_000));
    const { queryByText } = render(
      withIntl(
        <LockScreen userEmail="a@b.c">
          <span>secret-content</span>
        </LockScreen>,
      ),
    );
    expect(queryByText("secret-content")).toBeNull();
  });

  it("永不(默认)→ children 正常在 DOM(不锁不卸载)", () => {
    const { queryByText } = render(
      <LockScreen userEmail="a@b.c">
        <span>secret-content</span>
      </LockScreen>,
    );
    expect(queryByText("secret-content")).not.toBeNull();
  });
});
