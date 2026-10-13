import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { IntlProvider } from "use-intl";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { messages } from "@/lib/i18n/messages";

// 设置页「用户」卡:登录的是谁、登出、手动查更新。
// 钉住三件用户看得见的事:
// ① 身份行 —— 有名有邮箱时两行都显示;
// ② 登出要过一道确认,成功后清掉闲置锁状态 + 查询缓存再去 /login;失败只报错、不跳走
//    (锁标志不清的话重新登录会当场又被锁上,见 clearIdleLockState 的注释);
// ③ 查更新:有新版走更新 toast,没有就说「已是最新」(与自动提示共用同一个 id)。
const {
  signOut,
  navigate,
  checkForUpdate,
  showUpdateToast,
  forgetQueryCache,
  toastError,
  toastSuccess,
} = vi.hoisted(() => ({
  signOut: vi.fn(),
  navigate: vi.fn(),
  checkForUpdate: vi.fn(),
  showUpdateToast: vi.fn(),
  forgetQueryCache: vi.fn(),
  toastError: vi.fn(),
  toastSuccess: vi.fn(),
}));

vi.mock("@/lib/core/auth-client", () => ({ signOut }));
vi.mock("@tanstack/react-router", async (orig) => ({
  ...(await orig<object>()),
  useNavigate: () => navigate,
}));
vi.mock("@/lib/pwa/service-worker", () => ({
  checkForUpdate,
  showUpdateToast,
  UPDATE_TOAST_ID: "sw-update",
}));
// 真实现底下是 IndexedDB(jsdom 没有);这里只关心「登出时清了」。
vi.mock("@/lib/queries/persist", () => ({ forgetQueryCache }));
vi.mock("@folio/ui", async (orig) => ({
  ...(await orig<object>()),
  toast: { error: toastError, success: toastSuccess },
}));

const { UserCard } = await import("@/routes/_authed/-settings/user-card");

const LOCK_FLAG = "folio_lock_locked";
const LAST_ACTIVE = "folio_lock_last_active";

function mount(user: { name?: string | null; email?: string | null }) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <IntlProvider locale="en" messages={messages.en} timeZone="UTC" now={new Date(0)}>
        <UserCard user={user} />
      </IntlProvider>
    </QueryClientProvider>,
  );
}

// 卡上那个按钮打开确认框;确认框里同名的那个才真登出(弹层后挂,取最后一个)。
async function confirmSignOut() {
  fireEvent.click(screen.getByRole("button", { name: "Sign out" }));
  await screen.findByText("Sign out?");
  const buttons = screen.getAllByRole("button", { name: "Sign out" });
  fireEvent.click(buttons[buttons.length - 1] as HTMLElement);
}

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  document.body.innerHTML = "";
  forgetQueryCache.mockResolvedValue(undefined);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("身份行", () => {
  it("有名字也有邮箱 → 名字作主行、邮箱作副行、首字母作头像", () => {
    mount({ name: "alice", email: "alice@example.com" });
    expect(screen.getByText("alice")).toBeTruthy();
    expect(screen.getByText("alice@example.com")).toBeTruthy();
    expect(screen.getByText("A")).toBeTruthy();
    expect(screen.queryByText("Self-hosted")).toBeNull();
  });
});

describe("登出", () => {
  it("点卡上的按钮只弹确认,不直接登出", async () => {
    mount({ name: "alice", email: "alice@example.com" });
    fireEvent.click(screen.getByRole("button", { name: "Sign out" }));
    await screen.findByText("Sign out?");
    expect(signOut).not.toHaveBeenCalled();
  });

  it("确认 → 登出,清闲置锁状态与查询缓存,再去 /login", async () => {
    localStorage.setItem(LOCK_FLAG, "123");
    localStorage.setItem(LAST_ACTIVE, "456");
    signOut.mockResolvedValue({ data: {} });
    mount({ name: "alice", email: "alice@example.com" });

    await confirmSignOut();

    await waitFor(() => expect(navigate).toHaveBeenCalledWith({ to: "/login" }));
    expect(signOut).toHaveBeenCalledTimes(1);
    expect(forgetQueryCache).toHaveBeenCalledTimes(1);
    expect(localStorage.getItem(LOCK_FLAG)).toBeNull();
    expect(localStorage.getItem(LAST_ACTIVE)).toBeNull();
    expect(toastError).not.toHaveBeenCalled();
  });

  it("服务端回错 → 报出那条错误,不跳走、不清缓存", async () => {
    localStorage.setItem(LOCK_FLAG, "123");
    signOut.mockResolvedValue({ error: { message: "server said no" } });
    mount({ name: "alice", email: "alice@example.com" });

    await confirmSignOut();

    await waitFor(() => expect(toastError).toHaveBeenCalledWith("server said no"));
    expect(navigate).not.toHaveBeenCalled();
    expect(forgetQueryCache).not.toHaveBeenCalled();
    expect(localStorage.getItem(LOCK_FLAG)).toBe("123");
  });

  it("服务端回错但没带文案 → 用本地化的兜底文案", async () => {
    signOut.mockResolvedValue({ error: {} });
    mount({ name: "alice", email: "alice@example.com" });

    await confirmSignOut();

    await waitFor(() => expect(toastError).toHaveBeenCalledWith("Couldn't sign out. Try again."));
  });
});

describe("手动查更新", () => {
  const clickCheck = () =>
    fireEvent.click(screen.getByRole("button", { name: "Check for updates" }));

  it("有新版 → 弹「有更新」toast", async () => {
    vi.useFakeTimers();
    checkForUpdate.mockResolvedValue(true);
    mount({ name: "alice", email: "alice@example.com" });

    clickCheck();
    await act(() =>
      vi.waitFor(() =>
        expect(showUpdateToast).toHaveBeenCalledWith({
          available: "Update available",
          update: "Update",
        }),
      ),
    );
    expect(checkForUpdate).toHaveBeenCalledTimes(1);
    expect(toastSuccess).not.toHaveBeenCalled();
  });

  it("没有新版 → 「已是最新」,与自动提示共用同一个 toast id", async () => {
    vi.useFakeTimers();
    checkForUpdate.mockResolvedValue(false);
    mount({ name: "alice", email: "alice@example.com" });

    clickCheck();
    await act(() => vi.advanceTimersByTimeAsync(700));

    expect(toastSuccess).toHaveBeenCalledWith("This is the latest version", { id: "sw-update" });
    expect(showUpdateToast).not.toHaveBeenCalled();
  });
});
