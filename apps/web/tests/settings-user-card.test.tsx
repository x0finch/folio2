import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { IntlProvider } from "use-intl";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { messages } from "@/lib/i18n/messages";

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

describe("identity row", () => {
  it("with name and email: name is the main row, email the sub row, initial as avatar", () => {
    mount({ name: "alice", email: "alice@example.com" });
    expect(screen.getByText("alice")).toBeTruthy();
    expect(screen.getByText("alice@example.com")).toBeTruthy();
    expect(screen.getByText("A")).toBeTruthy();
    expect(screen.queryByText("Self-hosted")).toBeNull();
  });
});

describe("sign out", () => {
  it("clicking the card button only opens a confirmation, does not sign out directly", async () => {
    mount({ name: "alice", email: "alice@example.com" });
    fireEvent.click(screen.getByRole("button", { name: "Sign out" }));
    await screen.findByText("Sign out?");
    expect(signOut).not.toHaveBeenCalled();
  });

  it("confirm: signs out, clears idle-lock state and query cache, then goes to /login", async () => {
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

  it("server returns an error: reports it, does not navigate or clear the cache", async () => {
    localStorage.setItem(LOCK_FLAG, "123");
    signOut.mockResolvedValue({ error: { message: "server said no" } });
    mount({ name: "alice", email: "alice@example.com" });

    await confirmSignOut();

    await waitFor(() => expect(toastError).toHaveBeenCalledWith("server said no"));
    expect(navigate).not.toHaveBeenCalled();
    expect(forgetQueryCache).not.toHaveBeenCalled();
    expect(localStorage.getItem(LOCK_FLAG)).toBe("123");
  });

  it("server returns an error without a message: uses the localized fallback copy", async () => {
    signOut.mockResolvedValue({ error: {} });
    mount({ name: "alice", email: "alice@example.com" });

    await confirmSignOut();

    await waitFor(() => expect(toastError).toHaveBeenCalledWith("Couldn't sign out. Try again."));
  });
});

describe("manual update check", () => {
  const clickCheck = () =>
    fireEvent.click(screen.getByRole("button", { name: "Check for updates" }));

  it('new version: shows the "update available" toast', async () => {
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

  it('no new version: "up to date", sharing the same toast id as the automatic prompt', async () => {
    vi.useFakeTimers();
    checkForUpdate.mockResolvedValue(false);
    mount({ name: "alice", email: "alice@example.com" });

    clickCheck();
    await act(() => vi.advanceTimersByTimeAsync(700));

    expect(toastSuccess).toHaveBeenCalledWith("This is the latest version", { id: "sw-update" });
    expect(showUpdateToast).not.toHaveBeenCalled();
  });
});
