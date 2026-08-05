import { fireEvent, render, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { IntlProvider } from "use-intl";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LockScreen } from "../src/components/lock-screen";
import { messages } from "../src/lib/i18n/messages";

// 登出路径要断言「调了 signOut」「跳了 /login」,两者都不该真发生 → mock 掉。
// router 只替换 useNavigate,其余保留原样(AuthShell 里的 LocaleSwitcher 等仍可能用到)。
const { signOutSpy, navigateSpy } = vi.hoisted(() => ({
  signOutSpy: vi.fn(),
  navigateSpy: vi.fn(),
}));
vi.mock("../src/lib/auth-client", () => ({
  signIn: { passkey: vi.fn(), email: vi.fn() },
  signOut: signOutSpy,
}));
vi.mock("@tanstack/react-router", async (orig) => ({
  ...(await orig<object>()),
  useNavigate: () => navigateSpy,
}));

// 锁定态会渲染锁屏 UI(useTranslations)→ 需要 IntlProvider。未锁的用例走 children、无需它。
const withIntl = (node: ReactNode) => (
  <IntlProvider locale="en" messages={messages.en}>
    {node}
  </IntlProvider>
);

// 闲置锁要过**两道门**(#353):① 开关开着(独立的键,不再是 timeout 的 "never" 档);
// ② 这台设备已就绪(注册过本机 platform passkey,记的是那条凭据的 id)。
// 缺任一都纯透传 children。想让锁真的落下,两个都得置。
const armDevice = () => localStorage.setItem("folio_lock_device_passkey", "pk_local");
const armSwitch = () => localStorage.setItem("folio_lock_enabled", "1");

// 两层 LockScreen(ADR 0029):开关关着 → 纯透传 children,不挂 useIdleLock。
// 反查点 = 活动监听没被注册:恒挂(旧结构)时 useIdleLock 会在 window 上装 mousemove 等,
// 这里断言关着时一个都没装 —— 证明整套闲置机制确实没进树,而非靠 hook 内部判 null。
describe("LockScreen 第一道门:开关关着不挂闲置机制", () => {
  beforeEach(() => localStorage.clear());
  afterEach(() => vi.restoreAllMocks());

  it("默认(开关未设)→ 渲染 children 且不注册活动监听", () => {
    const spy = vi.spyOn(window, "addEventListener");
    const { getByText } = render(
      <LockScreen>
        <span>hi</span>
      </LockScreen>,
    );
    expect(getByText("hi")).toBeTruthy();
    expect(spy.mock.calls.map((c) => c[0])).not.toContain("mousemove");
  });

  // 时长偏好留着但开关关掉 = 用户手动关的状态。时长不该把锁带起来。
  it("有时长偏好但开关关着 → 同样不注册活动监听", () => {
    localStorage.setItem("folio_lock_timeout", "5");
    armDevice();
    const spy = vi.spyOn(window, "addEventListener");
    render(
      <LockScreen>
        <span>hi</span>
      </LockScreen>,
    );
    expect(spy.mock.calls.map((c) => c[0])).not.toContain("mousemove");
  });

  it("开关开着 + 具体档 + 本设备就绪 → 挂 useIdleLock,注册活动监听", () => {
    localStorage.setItem("folio_lock_timeout", "5");
    armSwitch();
    armDevice();
    const spy = vi.spyOn(window, "addEventListener");
    render(
      <LockScreen>
        <span>hi</span>
      </LockScreen>,
    );
    expect(spy.mock.calls.map((c) => c[0])).toContain("mousemove");
  });
});

// 第二道门(#353):这台设备没有本机可用的 passkey → 根本不启用闲置锁。
// **宁可不锁,也不要把人关在门外** —— 锁上了却没有解锁手段,用户只剩登出一条路。
describe("LockScreen 第二道门:本设备未就绪不挂锁", () => {
  beforeEach(() => localStorage.clear());
  afterEach(() => vi.restoreAllMocks());

  it("开关开着但设备未就绪 → 透传 children,不注册活动监听", () => {
    localStorage.setItem("folio_lock_timeout", "5");
    armSwitch(); // 只过第一道门
    const spy = vi.spyOn(window, "addEventListener");
    const { getByText } = render(
      <LockScreen>
        <span>hi</span>
      </LockScreen>,
    );
    expect(getByText("hi")).toBeTruthy();
    expect(spy.mock.calls.map((c) => c[0])).not.toContain("mousemove");
  });

  it("设备未就绪时,连别处已置的锁标志也不生效(内容照常可见)", () => {
    localStorage.setItem("folio_lock_timeout", "1");
    armSwitch();
    localStorage.setItem("folio_lock_locked", "1"); // 别的标签锁了
    const { queryByText } = render(
      withIntl(
        <LockScreen>
          <span>secret-content</span>
        </LockScreen>,
      ),
    );
    expect(queryByText("secret-content")).not.toBeNull();
  });
});

// 锁定时卸载 children(不只是遮罩叠加):DOM 里不留内容,懂开发的人删遮罩也看不到底下数据。
describe("LockScreen 锁定时卸载 children", () => {
  beforeEach(() => localStorage.clear());
  afterEach(() => vi.restoreAllMocks());

  it("已处于锁定(共享锁标志已置)→ children 不在 DOM,只剩锁屏", () => {
    localStorage.setItem("folio_lock_timeout", "1"); // 具体档才挂 ActiveLockScreen
    armDevice();
    armSwitch();
    localStorage.setItem("folio_lock_locked", "1"); // 别处已锁 → 本组件初始即锁
    const { queryByText, getByRole } = render(
      withIntl(
        <LockScreen>
          <span>secret-content</span>
        </LockScreen>,
      ),
    );
    expect(queryByText("secret-content")).toBeNull(); // children 卸载,内容不进 DOM
    expect(getByRole("button", { name: /unlock with passkey/i })).toBeTruthy(); // 锁屏在
  });

  // 解锁只认 passkey(#353):密码框曾在这里,且带 current-password 让密码管理器代填 —— 于是
  // 「顺手偷看的人」进锁屏就看到密码已填好、点一下就进去。这条断言钉住它不会被加回来。
  it("锁屏上没有密码输入框", () => {
    localStorage.setItem("folio_lock_timeout", "1");
    armDevice();
    armSwitch();
    localStorage.setItem("folio_lock_locked", "1");
    const { container } = render(
      withIntl(
        <LockScreen>
          <span>secret-content</span>
        </LockScreen>,
      ),
    );
    expect(container.querySelector("input[type=password]")).toBeNull();
    expect(container.querySelector("input[autocomplete=current-password]")).toBeNull();
    expect(container.querySelector("input[autocomplete=username]")).toBeNull();
  });

  it("闲置到点锁(lastActive 陈旧)→ children 从 DOM 移除", () => {
    localStorage.setItem("folio_lock_timeout", "1");
    armDevice();
    armSwitch();
    localStorage.setItem("folio_lock_last_active", String(Date.now() - 5 * 60_000));
    const { queryByText } = render(
      withIntl(
        <LockScreen>
          <span>secret-content</span>
        </LockScreen>,
      ),
    );
    expect(queryByText("secret-content")).toBeNull();
  });

  it("永不(默认)→ children 正常在 DOM(不锁不卸载)", () => {
    const { queryByText } = render(
      <LockScreen>
        <span>secret-content</span>
      </LockScreen>,
    );
    expect(queryByText("secret-content")).not.toBeNull();
  });
});

// 锁屏的逃生出口(#353)。锁屏是全屏接管、无别的出路:passkey 认不过去(换设备 / 指纹坏 /
// passkey 被删)时用户会被关在门外,所以必须留一条登出。
//
// 这里的重点**不是**「按钮存在」,而是它不能把用户送进一个环:登出若不清闲置锁状态,重新
// 登录时 LockScreen 一挂载就又锁上(锁标志仍在 / lastActive 仍是陈旧值),于是
// 「锁屏 → 登出 → 登录 → 锁屏」无限循环,比没有按钮更糟。
describe("LockScreen 锁定时可登出", () => {
  beforeEach(() => {
    localStorage.clear();
    signOutSpy.mockClear();
    navigateSpy.mockClear();
  });
  afterEach(() => vi.restoreAllMocks());

  const renderLocked = () => {
    localStorage.setItem("folio_lock_timeout", "1");
    armDevice();
    armSwitch();
    localStorage.setItem("folio_lock_locked", "1");
    return render(
      withIntl(
        <LockScreen>
          <span>secret-content</span>
        </LockScreen>,
      ),
    );
  };

  it("锁屏上有登出按钮", () => {
    const { getByRole } = renderLocked();
    expect(getByRole("button", { name: /sign out/i })).toBeTruthy();
  });

  it("点登出 → 清掉闲置锁状态、调 signOut、跳 /login", async () => {
    const { getByRole } = renderLocked();
    fireEvent.click(getByRole("button", { name: /sign out/i }));
    await waitFor(() => expect(navigateSpy).toHaveBeenCalledWith({ to: "/login" }));
    expect(signOutSpy).toHaveBeenCalled();
    // 两个 key 都得清:锁标志留着 → 重登即锁;lastActive 留着(陈旧)→ 挂载即判过期也锁。
    expect(localStorage.getItem("folio_lock_locked")).toBeNull();
    expect(localStorage.getItem("folio_lock_last_active")).toBeNull();
  });

  it("登出后重新挂载不再自动锁(不成环)", async () => {
    const { getByRole, unmount } = renderLocked();
    fireEvent.click(getByRole("button", { name: /sign out/i }));
    await waitFor(() => expect(navigateSpy).toHaveBeenCalled());
    unmount();

    // 模拟重新登录:超时偏好与「本设备就绪」都是**设备级**事实,登出不该清它们(passkey 不会
    // 因为登出而消失)—— 所以两者都还在,锁却不该再落下。
    expect(localStorage.getItem("folio_lock_timeout")).toBe("1");
    expect(localStorage.getItem("folio_lock_device_passkey")).not.toBeNull();
    const { queryByText } = render(
      withIntl(
        <LockScreen>
          <span>secret-content</span>
        </LockScreen>,
      ),
    );
    expect(queryByText("secret-content")).not.toBeNull(); // 内容可见 = 没被锁
  });
});
