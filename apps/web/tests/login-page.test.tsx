import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { IntlProvider } from "use-intl";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { messages } from "@/lib/i18n/messages";

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

function stubWebAuthn(conditional = false) {
  vi.stubGlobal(
    "PublicKeyCredential",
    // biome-ignore lint/complexity/noStaticOnlyClass: fakes a platform constructor, see above
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

describe("email and password sign-in", () => {
  it("submit: calls signIn.email with the entered credentials, goes home on success", async () => {
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

  it("server returns an error: shows it, does not navigate", async () => {
    signInEmail.mockResolvedValue({ error: { message: "Invalid email or password" } });
    const { type, submit } = mount();
    type("email", "alice@example.com");
    type("password", "wrongwrong");
    submit();

    await screen.findByText("Invalid email or password");
    expect(navigate).not.toHaveBeenCalled();
  });

  it("request throws (offline): shows the generic failure copy, button is clickable again", async () => {
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

describe("sign-up", () => {
  it("empty Name: uses the part of the email before @ as the name for signUp.email", async () => {
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

  it("Name filled: trimmed and used as the name", async () => {
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

  it("switching sign-in/sign-up clears the previous error", async () => {
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

describe("explicit passkey entry", () => {
  it("browser without WebAuthn: entry hidden", () => {
    const { passkeyButton } = mount();
    expect(passkeyButton()).toBeNull();
  });

  it("supported: entry shown in sign-in mode, hidden in sign-up (no account yet)", async () => {
    stubWebAuthn();
    const { passkeyButton } = mount();
    await waitFor(() => expect(passkeyButton()).not.toBeNull());
    fireEvent.click(screen.getByRole("tab", { name: "Sign up" }));
    expect(passkeyButton()).toBeNull();
  });

  it("click the entry: signIn.passkey, on success cancels autofill first then goes home", async () => {
    stubWebAuthn();
    signInPasskey.mockResolvedValue({ data: {} });
    const { passkeyButton } = mount();
    const btn = await waitFor(() => passkeyButton() as HTMLElement);
    cancelCeremony.mockClear();
    fireEvent.click(btn);

    await waitFor(() => expect(navigate).toHaveBeenCalledWith({ to: "/" }));
    expect(signInPasskey).toHaveBeenCalledWith();
    expect(cancelCeremony).toHaveBeenCalled();
    expect(cancelCeremony.mock.invocationCallOrder[0]).toBeLessThan(
      navigate.mock.invocationCallOrder[0] as number,
    );
  });

  it("passkey returns an error: shows it, does not navigate", async () => {
    stubWebAuthn();
    signInPasskey.mockResolvedValue({ error: { message: "No passkey found" } });
    const { passkeyButton } = mount();
    fireEvent.click(await waitFor(() => passkeyButton() as HTMLElement));

    await screen.findByText("No passkey found");
    expect(navigate).not.toHaveBeenCalled();
  });

  it("passkey throws (user cancelled): generic failure copy", async () => {
    stubWebAuthn();
    signInPasskey.mockRejectedValue(new Error("NotAllowedError"));
    const { passkeyButton } = mount();
    fireEvent.click(await waitFor(() => passkeyButton() as HTMLElement));

    await screen.findByText("Authentication failed");
  });
});

describe("conditional-UI autofill", () => {
  it("browser supports it: starts autofill silently on page load, selecting goes home", async () => {
    stubWebAuthn(true);
    signInPasskey.mockResolvedValue({ data: {} });
    mount();

    await waitFor(() => expect(navigate).toHaveBeenCalledWith({ to: "/" }));
    expect(signInPasskey).toHaveBeenCalledWith({ autoFill: true });
  });

  it("no conditional UI support: not started", async () => {
    stubWebAuthn(false);
    const { passkeyButton } = mount();
    await waitFor(() => expect(passkeyButton()).not.toBeNull());
    expect(signInPasskey).not.toHaveBeenCalled();
  });

  it("unmounting the login page: aborts the pending autofill", async () => {
    stubWebAuthn(true);
    signInPasskey.mockImplementation(() => new Promise(() => {}));
    const { unmount } = mount();
    await waitFor(() => expect(signInPasskey).toHaveBeenCalled());
    cancelCeremony.mockClear();

    unmount();

    expect(cancelCeremony).toHaveBeenCalled();
  });
});

describe("passkey onboarding after password sign-in", () => {
  async function signInWithPassword(utils: ReturnType<typeof mount>) {
    signInEmail.mockResolvedValue({ data: {} });
    await waitFor(() => expect(utils.passkeyButton()).not.toBeNull());
    utils.type("email", "alice@example.com");
    utils.type("password", "hunter2hunter2");
    utils.submit();
  }

  it("account has no passkey yet: shows the prompt, does not navigate yet", async () => {
    stubWebAuthn();
    listUserPasskeys.mockResolvedValue({ data: [] });
    const utils = mount();
    await signInWithPassword(utils);

    await screen.findByText("Sign in faster next time");
    expect(navigate).not.toHaveBeenCalled();
  });

  it("account already has a passkey: no prompt, goes home", async () => {
    stubWebAuthn();
    listUserPasskeys.mockResolvedValue({ data: [{ id: "pk1" }] });
    const utils = mount();
    await signInWithPassword(utils);

    await waitFor(() => expect(navigate).toHaveBeenCalledWith({ to: "/" }));
    expect(screen.queryByText("Sign in faster next time")).toBeNull();
  });

  it('"don\'t ask again" already clicked on this device: does not even query the list, goes home', async () => {
    stubWebAuthn();
    localStorage.setItem(DISMISSED_KEY, "1");
    const utils = mount();
    await signInWithPassword(utils);

    await waitFor(() => expect(navigate).toHaveBeenCalledWith({ to: "/" }));
    expect(listUserPasskeys).not.toHaveBeenCalled();
  });

  it('"don\'t ask again": remembered on this device, goes home', async () => {
    stubWebAuthn();
    listUserPasskeys.mockResolvedValue({ data: [] });
    const utils = mount();
    await signInWithPassword(utils);

    fireEvent.click(await screen.findByRole("button", { name: "Don't ask again" }));

    await waitFor(() => expect(navigate).toHaveBeenCalledWith({ to: "/" }));
    expect(localStorage.getItem(DISMISSED_KEY)).toBe("1");
    expect(addPasskey).not.toHaveBeenCalled();
  });

  it('"Add": only accepts a platform authenticator, records the credentialID, but does not enable the idle lock', async () => {
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

  it('"Add" fails: no credential recorded, still goes home (onboarding must not block sign-in)', async () => {
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

describe("password manager autofill auto-submit", () => {
  const animate = (el: HTMLElement, animationName: string) => {
    const ev = new Event("webkitAnimationStart", { bubbles: true });
    Object.defineProperty(ev, "animationName", { value: animationName });
    fireEvent(el, ev);
  };
  const autofill = (el: HTMLElement) => animate(el, "folio-autofill");

  it("both fields autofilled: signs in automatically, submitting once", async () => {
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

  it("only one field autofilled: no submit", async () => {
    const { type, field } = mount();
    type("email", "alice@example.com");
    type("password", "hunter2hunter2");
    autofill(field("email"));
    await Promise.resolve();
    expect(signInEmail).not.toHaveBeenCalled();
  });

  it("other animations do not count as autofill: no submit", async () => {
    const { type, field } = mount();
    type("email", "alice@example.com");
    type("password", "hunter2hunter2");
    animate(field("email"), "fade-in");
    animate(field("password"), "fade-in");
    await Promise.resolve();
    expect(signInEmail).not.toHaveBeenCalled();
  });

  it("sign-up mode does not auto-submit even when autofilled", async () => {
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
