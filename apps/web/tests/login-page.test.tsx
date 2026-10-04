import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { IntlProvider } from "use-intl";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { messages } from "@/lib/i18n/messages";

// 登录页(邮箱密码 + passkey)。这里钉住的是「点了之后调了谁、带了什么、落到哪」:
// ① 登录 / 注册各调对的那个认证接口,注册时 Name 留空兜底取邮箱 @ 前那段;
// ② 失败(回错 / 抛异常)都要落成屏幕上的错误,且不跳走;
// ③ passkey 入口只在浏览器支持时出现,只在登录态出现;
// ④ 密码登录后的 passkey 引导:够条件才弹(支持 + 没点过「别再问」+ 账户还没 passkey),
//    「别再问」按设备记下,「添加」限定本机认证器并记下 credentialID;成败都进主页;
// ⑤ 离开登录页前**先**掐掉挂起的 conditional-UI autofill(iOS 上它会泄漏到总览,见源文件注释);
// ⑥ 密码管理器把两格都 autofill 了才自动提交,手输永不自动提交。
// 真 WebAuthn ceremony 不在这里测 —— jsdom 没有,得靠 E2E。
const {
  signInEmail,
  signInPasskey,
  signUpEmail,
  listUserPasskeys,
  addPasskey,
  updatePasskey,
  navigate,
  cancelCeremony,
} = vi.hoisted(() => ({
  signInEmail: vi.fn(),
  signInPasskey: vi.fn(),
  signUpEmail: vi.fn(),
  listUserPasskeys: vi.fn(),
  addPasskey: vi.fn(),
  updatePasskey: vi.fn(),
  navigate: vi.fn(),
  cancelCeremony: vi.fn(),
}));

vi.mock("@/lib/core/auth-client", () => ({
  authClient: { passkey: { listUserPasskeys, addPasskey, updatePasskey } },
  signIn: { email: signInEmail, passkey: signInPasskey },
  signUp: { email: signUpEmail },
  signOut: vi.fn(),
}));
vi.mock("@/lib/server/preferences", () => ({ getCurrencyPreference: vi.fn() }));
vi.mock("@tanstack/react-router", async (orig) => ({
  ...(await orig<object>()),
  useNavigate: () => navigate,
}));
vi.mock("@simplewebauthn/browser", async (orig) => ({
  ...(await orig<object>()),
  WebAuthnAbortService: { cancelCeremony },
}));

const { LoginPage } = await import("@/routes/-login");

const DISMISSED_KEY = "folio_passkey_prompt_dismissed";
const DEVICE_KEY = "folio_lock_device_passkey";

function mount() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const utils = render(
    <QueryClientProvider client={client}>
      <IntlProvider locale="en" messages={messages.en} timeZone="UTC" now={new Date(0)}>
        <LoginPage />
      </IntlProvider>
    </QueryClientProvider>,
  );
  const field = (id: string) => utils.container.querySelector(`#${id}`) as HTMLInputElement;
  const type = (id: string, value: string) => fireEvent.change(field(id), { target: { value } });
  const submit = () =>
    fireEvent.click(utils.container.querySelector('button[type="submit"]') as HTMLButtonElement);
  const passkeyButton = () => screen.queryByRole("button", { name: /sign in with passkey/i });
  return { ...utils, field, type, submit, passkeyButton };
}

// 支持 WebAuthn 的浏览器。conditional UI 缺省不可用,要测 autofill 的用例自己打开。
function stubWebAuthn(conditional = false) {
  vi.stubGlobal(
    "PublicKeyCredential",
    // 替身必须是类:真身 `PublicKeyCredential` 是构造器。
    // biome-ignore lint/complexity/noStaticOnlyClass: 仿造的是平台构造器,见上
    class {
      static isConditionalMediationAvailable() {
        return Promise.resolve(conditional);
      }
    },
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  document.body.innerHTML = "";
  updatePasskey.mockResolvedValue({ data: {} });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("邮箱密码登录", () => {
  it("提交 → 用填的邮箱密码调 signIn.email,成功进主页", async () => {
    signInEmail.mockResolvedValue({ data: {} });
    const { type, submit } = mount();
    type("email", "alice@example.com");
    type("password", "hunter2hunter2");
    submit();

    await waitFor(() => expect(navigate).toHaveBeenCalledWith({ to: "/" }));
    expect(signInEmail).toHaveBeenCalledWith({
      email: "alice@example.com",
      password: "hunter2hunter2",
    });
    expect(signUpEmail).not.toHaveBeenCalled();
  });

  it("服务端回错 → 显示那条错误,不跳走", async () => {
    signInEmail.mockResolvedValue({ error: { message: "Invalid email or password" } });
    const { type, submit } = mount();
    type("email", "alice@example.com");
    type("password", "wrongwrong");
    submit();

    await screen.findByText("Invalid email or password");
    expect(navigate).not.toHaveBeenCalled();
  });

  it("请求抛异常(断网)→ 显示通用失败文案,按钮恢复可点", async () => {
    signInEmail.mockRejectedValue(new Error("network"));
    const { type, submit, container } = mount();
    type("email", "alice@example.com");
    type("password", "hunter2hunter2");
    submit();

    await screen.findByText("Authentication failed");
    const btn = container.querySelector('button[type="submit"]') as HTMLButtonElement;
    expect(btn.disabled).toBe(false);
    expect(navigate).not.toHaveBeenCalled();
  });
});

describe("注册", () => {
  it("Name 留空 → 用邮箱 @ 前那段作名字调 signUp.email", async () => {
    signUpEmail.mockResolvedValue({ data: {} });
    const { type, submit } = mount();
    fireEvent.click(screen.getByRole("tab", { name: "Sign up" }));
    type("email", "carol@example.com");
    type("password", "hunter2hunter2");
    submit();

    await waitFor(() => expect(navigate).toHaveBeenCalledWith({ to: "/" }));
    expect(signUpEmail).toHaveBeenCalledWith({
      email: "carol@example.com",
      password: "hunter2hunter2",
      name: "carol",
    });
    expect(signInEmail).not.toHaveBeenCalled();
  });

  it("填了 Name → 去掉两侧空白后作名字", async () => {
    signUpEmail.mockResolvedValue({ data: {} });
    const { type, submit } = mount();
    fireEvent.click(screen.getByRole("tab", { name: "Sign up" }));
    type("email", "carol@example.com");
    type("name", "  Carol C  ");
    type("password", "hunter2hunter2");
    submit();

    await waitFor(() => expect(signUpEmail).toHaveBeenCalled());
    expect(signUpEmail.mock.calls[0]?.[0]).toMatchObject({ name: "Carol C" });
  });

  it("切换登录/注册会清掉上一次的错误", async () => {
    signInEmail.mockResolvedValue({ error: { message: "Invalid email or password" } });
    const { type, submit } = mount();
    type("email", "alice@example.com");
    type("password", "wrongwrong");
    submit();
    await screen.findByText("Invalid email or password");

    fireEvent.click(screen.getByRole("tab", { name: "Sign up" }));

    expect(screen.queryByText("Invalid email or password")).toBeNull();
  });
});

describe("passkey 显式入口", () => {
  it("浏览器不支持 WebAuthn → 不露入口", () => {
    const { passkeyButton } = mount();
    expect(passkeyButton()).toBeNull();
  });

  it("支持 → 登录态露入口,注册态不露(还没账号)", async () => {
    stubWebAuthn();
    const { passkeyButton } = mount();
    await waitFor(() => expect(passkeyButton()).not.toBeNull());
    fireEvent.click(screen.getByRole("tab", { name: "Sign up" }));
    expect(passkeyButton()).toBeNull();
  });

  it("点入口 → signIn.passkey,成功先掐 autofill 再进主页", async () => {
    stubWebAuthn();
    signInPasskey.mockResolvedValue({ data: {} });
    const { passkeyButton } = mount();
    const btn = await waitFor(() => passkeyButton() as HTMLElement);
    cancelCeremony.mockClear(); // 只看点击之后那一次离开
    fireEvent.click(btn);

    await waitFor(() => expect(navigate).toHaveBeenCalledWith({ to: "/" }));
    expect(signInPasskey).toHaveBeenCalledWith();
    expect(cancelCeremony).toHaveBeenCalled();
    expect(cancelCeremony.mock.invocationCallOrder[0]).toBeLessThan(
      navigate.mock.invocationCallOrder[0] as number,
    );
  });

  it("passkey 回错 → 显示错误,不跳走", async () => {
    stubWebAuthn();
    signInPasskey.mockResolvedValue({ error: { message: "No passkey found" } });
    const { passkeyButton } = mount();
    fireEvent.click(await waitFor(() => passkeyButton() as HTMLElement));

    await screen.findByText("No passkey found");
    expect(navigate).not.toHaveBeenCalled();
  });

  it("passkey 抛异常(用户取消)→ 通用失败文案", async () => {
    stubWebAuthn();
    signInPasskey.mockRejectedValue(new Error("NotAllowedError"));
    const { passkeyButton } = mount();
    fireEvent.click(await waitFor(() => passkeyButton() as HTMLElement));

    await screen.findByText("Authentication failed");
  });
});

describe("conditional-UI autofill", () => {
  it("浏览器支持 → 进页即静默发起 autofill,选中即进主页", async () => {
    stubWebAuthn(true);
    signInPasskey.mockResolvedValue({ data: {} });
    mount();

    await waitFor(() => expect(navigate).toHaveBeenCalledWith({ to: "/" }));
    expect(signInPasskey).toHaveBeenCalledWith({ autoFill: true });
  });

  it("不支持 conditional UI → 不发起", async () => {
    stubWebAuthn(false);
    const { passkeyButton } = mount();
    await waitFor(() => expect(passkeyButton()).not.toBeNull());
    expect(signInPasskey).not.toHaveBeenCalled();
  });

  it("卸载登录页 → 掐掉挂起的 autofill", async () => {
    stubWebAuthn(true);
    signInPasskey.mockImplementation(() => new Promise(() => {}));
    const { unmount } = mount();
    await waitFor(() => expect(signInPasskey).toHaveBeenCalled());
    cancelCeremony.mockClear();

    unmount();

    expect(cancelCeremony).toHaveBeenCalled();
  });
});

describe("密码登录后的 passkey 引导", () => {
  async function signInWithPassword(utils: ReturnType<typeof mount>) {
    signInEmail.mockResolvedValue({ data: {} });
    await waitFor(() => expect(utils.passkeyButton()).not.toBeNull()); // 支持检测已落地
    utils.type("email", "alice@example.com");
    utils.type("password", "hunter2hunter2");
    utils.submit();
  }

  it("账户还没 passkey → 弹引导,先不跳走", async () => {
    stubWebAuthn();
    listUserPasskeys.mockResolvedValue({ data: [] });
    const utils = mount();
    await signInWithPassword(utils);

    await screen.findByText("Sign in faster next time");
    expect(navigate).not.toHaveBeenCalled();
  });

  it("账户已有 passkey → 不弹,直接进主页", async () => {
    stubWebAuthn();
    listUserPasskeys.mockResolvedValue({ data: [{ id: "pk1" }] });
    const utils = mount();
    await signInWithPassword(utils);

    await waitFor(() => expect(navigate).toHaveBeenCalledWith({ to: "/" }));
    expect(screen.queryByText("Sign in faster next time")).toBeNull();
  });

  it("本设备点过「别再问」→ 连列表都不查,直接进主页", async () => {
    stubWebAuthn();
    localStorage.setItem(DISMISSED_KEY, "1");
    const utils = mount();
    await signInWithPassword(utils);

    await waitFor(() => expect(navigate).toHaveBeenCalledWith({ to: "/" }));
    expect(listUserPasskeys).not.toHaveBeenCalled();
  });

  it("「别再问」→ 本设备记下,进主页", async () => {
    stubWebAuthn();
    listUserPasskeys.mockResolvedValue({ data: [] });
    const utils = mount();
    await signInWithPassword(utils);

    fireEvent.click(await screen.findByRole("button", { name: "Don't ask again" }));

    await waitFor(() => expect(navigate).toHaveBeenCalledWith({ to: "/" }));
    expect(localStorage.getItem(DISMISSED_KEY)).toBe("1");
    expect(addPasskey).not.toHaveBeenCalled();
  });

  it("「添加」→ 只收本机认证器,记下 credentialID,但不打开闲置锁", async () => {
    stubWebAuthn();
    listUserPasskeys.mockResolvedValue({ data: [] });
    addPasskey.mockResolvedValue({ data: { id: "row_1", credentialID: "cred_1" } });
    const utils = mount();
    await signInWithPassword(utils);

    fireEvent.click(await screen.findByRole("button", { name: "Add passkey" }));

    await waitFor(() => expect(navigate).toHaveBeenCalledWith({ to: "/" }));
    expect(addPasskey).toHaveBeenCalledWith({ authenticatorAttachment: "platform" });
    expect(localStorage.getItem(DEVICE_KEY)).toBe("cred_1");
    expect(localStorage.getItem("folio_lock_enabled")).toBeNull();
    expect(localStorage.getItem(DISMISSED_KEY)).toBeNull();
  });

  it("「添加」失败 → 不记凭据,照样进主页(引导不该卡住登录)", async () => {
    stubWebAuthn();
    listUserPasskeys.mockResolvedValue({ data: [] });
    addPasskey.mockRejectedValue(new Error("cancelled"));
    const utils = mount();
    await signInWithPassword(utils);

    fireEvent.click(await screen.findByRole("button", { name: "Add passkey" }));

    await waitFor(() => expect(navigate).toHaveBeenCalledWith({ to: "/" }));
    expect(localStorage.getItem(DEVICE_KEY)).toBeNull();
  });
});

describe("密码管理器 autofill 自动提交", () => {
  // jsdom 没有 AnimationEvent:React 因此退到带厂商前缀的事件名(webkitAnimationStart)去监听,
  // fireEvent 传进去的 animationName 也会被丢掉 → 手造一个事件,按 React 实际监听的名字派发。
  const animate = (el: HTMLElement, animationName: string) => {
    const ev = new Event("webkitAnimationStart", { bubbles: true });
    Object.defineProperty(ev, "animationName", { value: animationName });
    fireEvent(el, ev);
  };
  const autofill = (el: HTMLElement) => animate(el, "folio-autofill");

  it("两格都被 autofill 填上 → 自动登录,只提交一次", async () => {
    signInEmail.mockResolvedValue({ error: { message: "Invalid email or password" } });
    const { type, field } = mount();
    type("email", "alice@example.com");
    type("password", "hunter2hunter2");
    autofill(field("email"));
    autofill(field("password"));

    await screen.findByText("Invalid email or password");
    expect(signInEmail).toHaveBeenCalledTimes(1);
    expect(signInEmail).toHaveBeenCalledWith({
      email: "alice@example.com",
      password: "hunter2hunter2",
    });
  });

  it("只有一格被 autofill → 不提交", async () => {
    const { type, field } = mount();
    type("email", "alice@example.com");
    type("password", "hunter2hunter2");
    autofill(field("email"));
    await Promise.resolve();
    expect(signInEmail).not.toHaveBeenCalled();
  });

  it("别的动画不算 autofill → 不提交", async () => {
    const { type, field } = mount();
    type("email", "alice@example.com");
    type("password", "hunter2hunter2");
    animate(field("email"), "fade-in");
    animate(field("password"), "fade-in");
    await Promise.resolve();
    expect(signInEmail).not.toHaveBeenCalled();
  });

  it("注册态下即使被 autofill 也不自动提交", async () => {
    const { type, field } = mount();
    fireEvent.click(screen.getByRole("tab", { name: "Sign up" }));
    type("email", "alice@example.com");
    type("password", "hunter2hunter2");
    autofill(field("email"));
    autofill(field("password"));
    await Promise.resolve();
    expect(signUpEmail).not.toHaveBeenCalled();
    expect(signInEmail).not.toHaveBeenCalled();
  });
});
