import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { IntlProvider } from "use-intl";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LockScreen } from "@/components/lock-screen";
import { messages } from "@/lib/i18n/messages";

const { signOutSpy, navigateSpy } = vi.hoisted(() => ({
  signOutSpy: vi.fn(),
  navigateSpy: vi.fn(),
}));
vi.mock("@/lib/server/preferences", () => ({
  getCurrencyPreference: vi.fn(),
}));
vi.mock("@/lib/core/auth-client", () => ({
  signIn: { passkey: vi.fn(), email: vi.fn() },
  signOut: signOutSpy,
}));
const { lockSpy, forgetSpy } = vi.hoisted(() => ({ lockSpy: vi.fn(), forgetSpy: vi.fn() }));
vi.mock("@/lib/queries/persist", async (orig) => {
  const real = await orig<typeof import("@/lib/queries/persist")>();
  return {
    ...real,
    lockQueryCache: (qc: QueryClient) => {
      lockSpy(qc);
      return real.lockQueryCache(qc);
    },
    forgetQueryCache: (qc: QueryClient) => {
      forgetSpy(qc);
      return real.forgetQueryCache(qc);
    },
  };
});
vi.mock("@tanstack/react-router", async (orig) => ({
  ...(await orig<object>()),
  useNavigate: () => navigateSpy,
}));

const withIntl = (node: ReactNode) => (
  <QueryClientProvider client={new QueryClient()}>
    <IntlProvider locale="en" messages={messages.en}>
      {node}
    </IntlProvider>
  </QueryClientProvider>
);

const armDevice = () => localStorage.setItem("folio_lock_device_passkey", "pk_local");
const armSwitch = () => localStorage.setItem("folio_lock_enabled", "1");

describe("LockScreen first gate: with the switch off, no idle machinery is mounted", () => {
  beforeEach(() => localStorage.clear());
  afterEach(() => vi.restoreAllMocks());

  it("default (switch unset): renders children and registers no activity listener", () => {
    const spy = vi.spyOn(window, "addEventListener");
    const { getByText } = render(
      <LockScreen>
        <span>hi</span>
      </LockScreen>,
    );
    expect(getByText("hi")).toBeTruthy();
    expect(spy.mock.calls.map((c) => c[0])).not.toContain("mousemove");
  });

  it("duration preference set but switch off: also registers no activity listener", () => {
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

  it("switch on + concrete tier + device ready: mounts useIdleLock, registers activity listeners", () => {
    localStorage.setItem("folio_lock_timeout", "5");
    armSwitch();
    armDevice();
    const spy = vi.spyOn(window, "addEventListener");
    render(
      withIntl(
        <LockScreen>
          <span>hi</span>
        </LockScreen>,
      ),
    );
    expect(spy.mock.calls.map((c) => c[0])).toContain("mousemove");
  });
});

describe("LockScreen locks even without a local credential record", () => {
  beforeEach(() => localStorage.clear());
  afterEach(() => vi.restoreAllMocks());

  it("switch on but no credential record: still mounts useIdleLock, registers activity listeners", () => {
    localStorage.setItem("folio_lock_timeout", "5");
    armSwitch();
    const spy = vi.spyOn(window, "addEventListener");
    render(
      withIntl(
        <LockScreen>
          <span>hi</span>
        </LockScreen>,
      ),
    );
    expect(spy.mock.calls.map((c) => c[0])).toContain("mousemove");
  });

  it("without a credential record, a lock flag set elsewhere still applies: content is not in the DOM", () => {
    localStorage.setItem("folio_lock_timeout", "1");
    armSwitch();
    localStorage.setItem("folio_lock_locked", "1");
    const { queryByText } = render(
      withIntl(
        <LockScreen>
          <span>secret-content</span>
        </LockScreen>,
      ),
    );
    expect(queryByText("secret-content")).toBeNull();
  });

  it("without a credential record the lock screen shows an extra note, the unlock button remains", () => {
    localStorage.setItem("folio_lock_timeout", "1");
    armSwitch();
    localStorage.setItem("folio_lock_locked", "1");
    const { getByText, getByRole } = render(
      withIntl(
        <LockScreen>
          <span>secret-content</span>
        </LockScreen>,
      ),
    );
    expect(getByText(/No passkey is registered for this device/)).toBeTruthy();
    expect(getByRole("button", { name: /unlock with passkey/i })).toBeTruthy();
  });

  it("with a credential record the note is not shown", () => {
    localStorage.setItem("folio_lock_timeout", "1");
    armSwitch();
    armDevice();
    localStorage.setItem("folio_lock_locked", "1");
    const { queryByText } = render(
      withIntl(
        <LockScreen>
          <span>secret-content</span>
        </LockScreen>,
      ),
    );
    expect(queryByText(/No passkey is registered for this device/)).toBeNull();
  });
});

describe("LockScreen unmounts children while locked", () => {
  beforeEach(() => localStorage.clear());
  afterEach(() => vi.restoreAllMocks());

  it("already locked (shared lock flag set): children not in the DOM, only the lock screen", () => {
    localStorage.setItem("folio_lock_timeout", "1");
    armDevice();
    armSwitch();
    localStorage.setItem("folio_lock_locked", "1");
    const { queryByText, getByRole } = render(
      withIntl(
        <LockScreen>
          <span>secret-content</span>
        </LockScreen>,
      ),
    );
    expect(queryByText("secret-content")).toBeNull();
    expect(getByRole("button", { name: /unlock with passkey/i })).toBeTruthy();
  });

  it("no password input on the lock screen", () => {
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

  it("idle timeout locks (stale lastActive): children removed from the DOM", () => {
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
});

//
describe("LockScreen can sign out while locked", () => {
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

  it("click sign out: clears idle-lock state, calls signOut, goes to /login", async () => {
    const { getByRole } = renderLocked();
    fireEvent.click(getByRole("button", { name: /sign out/i }));
    await waitFor(() => expect(navigateSpy).toHaveBeenCalledWith({ to: "/login" }));
    expect(signOutSpy).toHaveBeenCalled();
    expect(localStorage.getItem("folio_lock_locked")).toBeNull();
    expect(localStorage.getItem("folio_lock_last_active")).toBeNull();
  });

  it("remounting after sign-out does not lock again (no loop)", async () => {
    const { getByRole, unmount } = renderLocked();
    fireEvent.click(getByRole("button", { name: /sign out/i }));
    await waitFor(() => expect(navigateSpy).toHaveBeenCalled());
    unmount();

    expect(localStorage.getItem("folio_lock_timeout")).toBe("1");
    expect(localStorage.getItem("folio_lock_device_passkey")).not.toBeNull();
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

describe("LockScreen clears the query cache", () => {
  beforeEach(() => {
    localStorage.clear();
    lockSpy.mockClear();
    forgetSpy.mockClear();
    navigateSpy.mockClear();
  });

  const renderLockedWith = (client: QueryClient) => {
    localStorage.setItem("folio_lock_timeout", "1");
    armDevice();
    armSwitch();
    localStorage.setItem("folio_lock_locked", "1");
    return render(
      <QueryClientProvider client={client}>
        <IntlProvider locale="en" messages={messages.en}>
          <LockScreen>
            <span>secret-content</span>
          </LockScreen>
        </IntlProvider>
      </QueryClientProvider>,
    );
  };

  it("on lock: wipes storage and drops queries nobody has mounted from memory", async () => {
    const client = new QueryClient();
    client.setQueryData(["accounts", "list", "pf"], [{ id: "a1" }]);
    renderLockedWith(client);

    await waitFor(() => expect(lockSpy).toHaveBeenCalledWith(client));
    expect(client.getQueryData(["accounts", "list", "pf"])).toBeUndefined();
  });

  it("sign out on the lock screen: wipes storage + clears memory", async () => {
    const client = new QueryClient();
    const { getByRole } = renderLockedWith(client);
    client.setQueryData(["settings", "valuation"], { hideBalances: true });

    fireEvent.click(getByRole("button", { name: /sign out/i }));
    await waitFor(() => expect(navigateSpy).toHaveBeenCalledWith({ to: "/login" }));
    expect(forgetSpy).toHaveBeenCalledWith(client);
    expect(client.getQueryCache().getAll()).toHaveLength(0);
  });
});
