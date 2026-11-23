import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { IntlProvider } from "use-intl";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { messages } from "@/lib/i18n/messages";

//
const { addPasskey, deletePasskey, listUserPasskeys, updatePasskey, signInPasskey, toastError } =
  vi.hoisted(() => ({
    addPasskey: vi.fn(),
    deletePasskey: vi.fn(),
    listUserPasskeys: vi.fn(),
    updatePasskey: vi.fn(),
    signInPasskey: vi.fn(),
    toastError: vi.fn(),
  }));

vi.mock("@/lib/server/settings", () => ({
  getDataStats: vi.fn(),
  getProviderKeyStatus: vi.fn(),
  getValuationSettings: vi.fn(),
  updateValuationSettings: vi.fn(),
}));
vi.mock("@/lib/server/preferences", () => ({
  getCurrencyPreference: vi.fn(),
}));
vi.mock("@/lib/core/auth-client", () => ({
  authClient: { passkey: { addPasskey, deletePasskey, listUserPasskeys, updatePasskey } },
  signOut: vi.fn(),
  signIn: { passkey: signInPasskey, email: vi.fn() },
}));
vi.mock("@folio/ui", async (orig) => ({
  ...(await orig<object>()),
  toast: { error: toastError, success: vi.fn() },
}));

const { AutoLockCard } = await import("@/routes/_authed/-settings/passkey/auto-lock-card");
const { PasskeysCard } = await import("@/routes/_authed/-settings/passkey");

const DEVICE_KEY = "folio_lock_device_passkey";
const TIMEOUT_KEY = "folio_lock_timeout";
const ENABLED_KEY = "folio_lock_enabled";

const row = (cred: string, name: string) => ({
  id: `dbrow_${cred}`,
  credentialID: cred,
  name,
  createdAt: new Date(0).toISOString(),
  aaguid: null,
  backedUp: true,
  transports: "internal",
});

function mount(node: ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <IntlProvider locale="en" messages={messages.en} timeZone="UTC" now={new Date(0)}>
        {node}
      </IntlProvider>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  localStorage.clear();
  vi.clearAllMocks();
  listUserPasskeys.mockResolvedValue({ data: [] });
  updatePasskey.mockResolvedValue({ data: {} });
  //
  vi.stubGlobal(
    "PublicKeyCredential",
    // biome-ignore lint/complexity/noStaticOnlyClass: fakes a platform constructor, see above
    class {
      static isUserVerifyingPlatformAuthenticatorAvailable() {
        return Promise.resolve(true);
      }
    },
  );
});

const toggle = (utils: ReturnType<typeof mount>) =>
  fireEvent.click(utils.getByRole("switch", { name: /auto-lock/i }));

describe("AutoLockCard switch and enable prerequisites", () => {
  it("off: duration row greyed out and not clickable", () => {
    const { container } = mount(<AutoLockCard />);
    const gate = container.querySelector('[aria-disabled="true"]');
    expect(gate).not.toBeNull();
    expect(gate?.className).toContain("pointer-events-none");
  });

  //
  it("account has no passkey: registers directly, and must be restricted to the platform authenticator", async () => {
    addPasskey.mockResolvedValue({ data: row("cred_new", "这台") });
    const utils = mount(<AutoLockCard />);
    toggle(utils);
    await waitFor(() => expect(addPasskey).toHaveBeenCalled());
    expect(addPasskey.mock.calls[0]?.[0]).toMatchObject({ authenticatorAttachment: "platform" });
    expect(signInPasskey).not.toHaveBeenCalled();
  });

  it("registration passes no name (otherwise the system keychain would use the device name as the account name), device name written afterwards", async () => {
    addPasskey.mockResolvedValue({ data: row("cred_new", "这台") });
    const utils = mount(<AutoLockCard />);
    toggle(utils);
    await waitFor(() => expect(updatePasskey).toHaveBeenCalled());
    expect(addPasskey.mock.calls[0]?.[0]).not.toHaveProperty("name");
    const arg = updatePasskey.mock.calls[0]?.[0];
    expect(arg?.id).toBe("dbrow_cred_new");
    expect(typeof arg?.name).toBe("string");
    expect(arg?.name.length).toBeGreaterThan(0);
  });

  it("rename failure is not a registration failure: the credential is already created", async () => {
    addPasskey.mockResolvedValue({ data: row("cred_new", "这台") });
    updatePasskey.mockRejectedValue(new Error("network"));
    const utils = mount(<AutoLockCard />);
    toggle(utils);
    await waitFor(() => expect(localStorage.getItem(DEVICE_KEY)).toBe("cred_new"));
    expect(localStorage.getItem(ENABLED_KEY)).not.toBeNull();
    expect(toastError).not.toHaveBeenCalled();
  });

  it("enable succeeds: stores the credentialID (not the row primary key, not a boolean), switch turns on", async () => {
    addPasskey.mockResolvedValue({ data: row("cred_new", "这台") });
    const utils = mount(<AutoLockCard />);
    toggle(utils);
    await waitFor(() => expect(localStorage.getItem(DEVICE_KEY)).toBe("cred_new"));
    expect(localStorage.getItem(ENABLED_KEY)).not.toBeNull();
  });

  it("registration fails (user cancelled / no biometrics on this device): no marker written, switch stays off", async () => {
    addPasskey.mockResolvedValue({ error: { message: "cancelled" } });
    const utils = mount(<AutoLockCard />);
    toggle(utils);
    await waitFor(() => expect(addPasskey).toHaveBeenCalled());
    expect(localStorage.getItem(DEVICE_KEY)).toBeNull();
    expect(localStorage.getItem(ENABLED_KEY)).toBeNull();
  });

  const ASSERTED = { data: {}, webauthn: { response: { id: "cred_used" } } };

  it("account already has a passkey: verifies first, never touches registration", async () => {
    listUserPasskeys.mockResolvedValue({ data: [row("cred_used", "这台")] });
    signInPasskey.mockResolvedValue(ASSERTED);
    const utils = mount(<AutoLockCard />);
    toggle(utils);
    await waitFor(() => expect(localStorage.getItem(DEVICE_KEY)).toBe("cred_used"));
    expect(localStorage.getItem(ENABLED_KEY)).not.toBeNull();
    expect(addPasskey).not.toHaveBeenCalled();
    expect(toastError).not.toHaveBeenCalled();
    expect(signInPasskey.mock.calls[0]?.[0]).toMatchObject({ returnWebAuthnResponse: true });
  });

  it("account has a passkey but verification fails: falls back to registration, creating one for this device", async () => {
    listUserPasskeys.mockResolvedValue({ data: [row("cred_elsewhere", "别人的设备")] });
    signInPasskey.mockResolvedValue({ data: null, error: { message: "no credential here" } });
    addPasskey.mockResolvedValue({ data: row("cred_new", "这台") });
    const utils = mount(<AutoLockCard />);
    toggle(utils);
    await waitFor(() => expect(localStorage.getItem(DEVICE_KEY)).toBe("cred_new"));
    expect(localStorage.getItem(ENABLED_KEY)).not.toBeNull();
    expect(addPasskey.mock.calls[0]?.[0]).toMatchObject({ authenticatorAttachment: "platform" });
  });

  it("verification fails and registration fails too: no marker written, switch stays off", async () => {
    listUserPasskeys.mockResolvedValue({ data: [row("cred_elsewhere", "别人的设备")] });
    signInPasskey.mockResolvedValue({ data: null, error: { message: "cancelled" } });
    addPasskey.mockResolvedValue({ error: { message: "cancelled too" } });
    const utils = mount(<AutoLockCard />);
    toggle(utils);
    await waitFor(() => expect(toastError).toHaveBeenCalled());
    expect(localStorage.getItem(DEVICE_KEY)).toBeNull();
    expect(localStorage.getItem(ENABLED_KEY)).toBeNull();
  });

  it("account has no passkey and the session is past its freshness window: asks the user to sign in again", async () => {
    addPasskey.mockResolvedValue({
      error: { code: "SESSION_NOT_FRESH", message: "Session is not fresh" },
    });
    const utils = mount(<AutoLockCard />);
    toggle(utils);
    await waitFor(() => expect(toastError).toHaveBeenCalled());
    expect(toastError.mock.calls[0]?.[0]).toMatch(/sign in again/i);
    expect(localStorage.getItem(ENABLED_KEY)).toBeNull();
  });

  it("a local credential record is also re-verified: no shortcut", async () => {
    localStorage.setItem(DEVICE_KEY, "cred_local");
    listUserPasskeys.mockResolvedValue({ data: [row("cred_local", "这台")] });
    signInPasskey.mockResolvedValue({ data: {}, webauthn: { response: { id: "cred_local" } } });
    const utils = mount(<AutoLockCard />);
    await waitFor(() => expect(listUserPasskeys).toHaveBeenCalled());
    toggle(utils);
    await waitFor(() => expect(localStorage.getItem(ENABLED_KEY)).not.toBeNull());
    expect(signInPasskey).toHaveBeenCalled();
  });

  it("re-verification fails: switch does not turn on, the existing credential record is untouched", async () => {
    localStorage.setItem(DEVICE_KEY, "cred_local");
    listUserPasskeys.mockResolvedValue({ data: [row("cred_local", "这台")] });
    signInPasskey.mockResolvedValue({ data: null, error: { message: "cancelled" } });
    addPasskey.mockResolvedValue({ error: { message: "already" } });
    const utils = mount(<AutoLockCard />);
    await waitFor(() => expect(listUserPasskeys).toHaveBeenCalled());
    toggle(utils);
    await waitFor(() => expect(toastError).toHaveBeenCalled());
    expect(localStorage.getItem(ENABLED_KEY)).toBeNull();
    expect(localStorage.getItem(DEVICE_KEY)).toBe("cred_local");
  });

  it("turning off: clears only the switch, local credential and duration are kept", async () => {
    localStorage.setItem(DEVICE_KEY, "cred_local");
    localStorage.setItem(ENABLED_KEY, "1");
    localStorage.setItem(TIMEOUT_KEY, "5");
    listUserPasskeys.mockResolvedValue({ data: [row("cred_local", "这台")] });
    const utils = mount(<AutoLockCard />);
    await waitFor(() => expect(listUserPasskeys).toHaveBeenCalled());
    toggle(utils);
    await waitFor(() => expect(localStorage.getItem(ENABLED_KEY)).toBeNull());
    expect(localStorage.getItem(DEVICE_KEY)).toBe("cred_local");
    expect(localStorage.getItem(TIMEOUT_KEY)).toBe("5");
    expect(deletePasskey).not.toHaveBeenCalled();
  });

  it("stored credential no longer in the account list: clears the marker, but the lock stays on", async () => {
    localStorage.setItem(DEVICE_KEY, "cred_gone");
    localStorage.setItem(ENABLED_KEY, "1");
    listUserPasskeys.mockResolvedValue({ data: [row("cred_other", "别的设备")] });
    mount(<AutoLockCard />);
    await waitFor(() => expect(localStorage.getItem(DEVICE_KEY)).toBeNull());
    expect(localStorage.getItem(ENABLED_KEY)).not.toBeNull();
  });

  it("switch key present, credential record gone: switch still shows on, and prompts re-registration", async () => {
    localStorage.setItem(ENABLED_KEY, "1");
    listUserPasskeys.mockResolvedValue({ data: [] });
    const utils = mount(<AutoLockCard />);
    await waitFor(() =>
      expect(utils.getByRole("switch", { name: /auto-lock/i }).getAttribute("aria-checked")).toBe(
        "true",
      ),
    );
    expect(utils.getByText(/No passkey is registered for this device/)).toBeTruthy();
  });

  it("stored credential still in the list: stays ready, no false clearing", async () => {
    localStorage.setItem(DEVICE_KEY, "cred_local");
    localStorage.setItem(ENABLED_KEY, "1");
    localStorage.setItem(TIMEOUT_KEY, "15");
    listUserPasskeys.mockResolvedValue({ data: [row("cred_local", "这台")] });
    mount(<AutoLockCard />);
    await waitFor(() => expect(listUserPasskeys).toHaveBeenCalled());
    expect(localStorage.getItem(DEVICE_KEY)).toBe("cred_local");
    expect(localStorage.getItem(ENABLED_KEY)).not.toBeNull();
    expect(localStorage.getItem(TIMEOUT_KEY)).toBe("15");
  });
});

describe("PasskeysCard add entry", () => {
  const clickAdd = (utils: ReturnType<typeof mount>) =>
    fireEvent.click(utils.getByRole("button", { name: /add passkey/i }));

  it("the plus button adds without restricting authenticator type (no authenticatorAttachment)", async () => {
    addPasskey.mockResolvedValue({ data: row("cred_key", "安全钥匙") });
    const utils = mount(<PasskeysCard />);
    clickAdd(utils);
    await waitFor(() => expect(addPasskey).toHaveBeenCalled());
    expect(addPasskey.mock.calls[0]?.[0]).not.toHaveProperty("authenticatorAttachment");
  });

  it("the plus button neither writes the local marker nor enables the idle lock", async () => {
    addPasskey.mockResolvedValue({ data: row("cred_key", "安全钥匙") });
    const utils = mount(<PasskeysCard />);
    clickAdd(utils);
    await waitFor(() => expect(addPasskey).toHaveBeenCalled());
    expect(localStorage.getItem(DEVICE_KEY)).toBeNull();
    expect(localStorage.getItem(ENABLED_KEY)).toBeNull();
  });

  it("the plus button add fails: error copy", async () => {
    addPasskey.mockResolvedValue({ error: { message: "cancelled" } });
    const utils = mount(<PasskeysCard />);
    clickAdd(utils);
    await waitFor(() => expect(toastError).toHaveBeenCalled());
  });

  const NOT_FRESH = { error: { code: "SESSION_NOT_FRESH", message: "Session is not fresh" } };

  it("session past its freshness window: verifies to refresh first, then retries registration", async () => {
    addPasskey.mockResolvedValueOnce(NOT_FRESH).mockResolvedValueOnce({
      data: row("cred_key", "安全钥匙"),
    });
    signInPasskey.mockResolvedValue({ data: {} });
    const utils = mount(<PasskeysCard />);
    clickAdd(utils);
    await waitFor(() => expect(addPasskey).toHaveBeenCalledTimes(2));
    expect(signInPasskey).toHaveBeenCalled();
    expect(toastError).not.toHaveBeenCalled();
    expect(localStorage.getItem(DEVICE_KEY)).toBeNull();
  });

  it("session expired and verification fails too (account has no passkey): asks the user to sign in again", async () => {
    addPasskey.mockResolvedValue(NOT_FRESH);
    signInPasskey.mockResolvedValue({ data: null, error: { message: "no credentials" } });
    const utils = mount(<PasskeysCard />);
    clickAdd(utils);
    await waitFor(() => expect(toastError).toHaveBeenCalled());
    expect(toastError.mock.calls[0]?.[0]).toMatch(/sign in again/i);
    expect(addPasskey).toHaveBeenCalledTimes(1);
  });
});

describe("PasskeysCard and idle lock interplay", () => {
  async function removeFirstRow(utils: ReturnType<typeof mount>) {
    const trash = utils.getAllByRole("button", { name: /remove/i })[0];
    if (!trash) throw new Error("no remove button");
    fireEvent.click(trash);
    await utils.findByText(/remove passkey\?/i);
    const confirm = [...utils.container.ownerDocument.querySelectorAll("button")].find((b) =>
      b.className.includes("bg-destructive"),
    );
    if (!confirm) throw new Error("no confirm button");
    fireEvent.click(confirm);
  }

  it('the "this device" badge appears only on the row whose credentialID matches', async () => {
    localStorage.setItem(DEVICE_KEY, "cred_local");
    listUserPasskeys.mockResolvedValue({
      data: [row("cred_local", "这台"), row("cred_other", "别的")],
    });
    const { findAllByText, getAllByText } = mount(<PasskeysCard />);
    await findAllByText("这台");
    expect(getAllByText(/this device/i)).toHaveLength(1);
  });

  it("deleting the local one: clears the marker, lock and duration untouched", async () => {
    localStorage.setItem(DEVICE_KEY, "cred_local");
    localStorage.setItem(ENABLED_KEY, "1");
    localStorage.setItem(TIMEOUT_KEY, "15");
    listUserPasskeys.mockResolvedValue({ data: [row("cred_local", "这台")] });
    deletePasskey.mockResolvedValue({ data: {} });
    const utils = mount(<PasskeysCard />);
    await utils.findByText("这台");
    await removeFirstRow(utils);
    await waitFor(() => expect(deletePasskey).toHaveBeenCalledWith({ id: "dbrow_cred_local" }));
    await waitFor(() => expect(localStorage.getItem(DEVICE_KEY)).toBeNull());
    expect(localStorage.getItem(ENABLED_KEY)).not.toBeNull();
    expect(localStorage.getItem(TIMEOUT_KEY)).toBe("15");
  });

  it("deleting another credential: marker and switch untouched", async () => {
    localStorage.setItem(DEVICE_KEY, "cred_local");
    localStorage.setItem(ENABLED_KEY, "1");
    listUserPasskeys.mockResolvedValue({ data: [row("cred_other", "别的")] });
    deletePasskey.mockResolvedValue({ data: {} });
    const utils = mount(<PasskeysCard />);
    await utils.findByText("别的");
    await removeFirstRow(utils);
    await waitFor(() => expect(deletePasskey).toHaveBeenCalledWith({ id: "dbrow_cred_other" }));
    expect(localStorage.getItem(DEVICE_KEY)).toBe("cred_local");
    expect(localStorage.getItem(ENABLED_KEY)).not.toBeNull();
  });
});
