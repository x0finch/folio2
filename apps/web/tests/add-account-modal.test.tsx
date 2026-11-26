import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { IntlProvider } from "use-intl";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { messages } from "@/lib/i18n/messages";
import { accountKeys, connectorKeys } from "@/lib/queries/keys";

// Add-account modal: type grid ↔ form, plus the add-credentials view. The forms are stubbed; we check
// what the modal hands them and what it does once they report done.
const { syncAccountAndWait, toastError, toastSuccess, listConnectors, getSpecs } = vi.hoisted(
  () => ({
    syncAccountAndWait: vi.fn(),
    toastError: vi.fn(),
    toastSuccess: vi.fn(),
    listConnectors: vi.fn(),
    getSpecs: vi.fn(),
  }),
);

vi.mock("@/lib/queries/account-sync", () => ({ syncAccountAndWait }));
vi.mock("@/lib/server/connectors", () => ({
  listConnectors,
  getConnectorCredentialSpecs: getSpecs,
}));
vi.mock("@folio/ui", async (orig) => ({
  ...(await orig<object>()),
  toast: { error: toastError, success: toastSuccess },
}));
vi.mock("@/components/account-fields", () => ({
  AccountForm: ({
    connectorId,
    specs,
    onDone,
  }: {
    connectorId: string;
    specs: { key: string }[];
    onDone: (id: string) => void;
  }) => (
    <div data-testid="account-form">
      {`form:${connectorId} specs:${specs.map((s) => s.key).join(",")}`}
      <button type="button" onClick={() => onDone("new_1")}>
        form-done
      </button>
    </div>
  ),
}));
vi.mock("@/components/credential-form", () => ({
  CredentialForm: ({
    accountId,
    specs,
    hint,
    onDone,
  }: {
    accountId: string;
    specs: { key: string }[];
    hint?: Record<string, string>;
    onDone: () => void;
  }) => (
    <div data-testid="cred-form">
      {`cred:${accountId} specs:${specs.map((s) => s.key).join(",")} hint:${JSON.stringify(hint)}`}
      <button type="button" onClick={onDone}>
        cred-done
      </button>
    </div>
  ),
}));

const { AddAccountModal } = await import("@/routes/_authed/-accounts/add-account-modal");

const SPECS = {
  binance: [{ key: "apiKey" }, { key: "apiSecret" }],
  evm: [{ key: "address" }],
};

const CATALOG = { binance: { label: "Binance" }, evm: { label: "EVM" } };

function wrap(node: React.ReactNode, catalog: object = CATALOG) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(connectorKeys.catalogue(), catalog);
  return {
    client,
    ui: (
      <QueryClientProvider client={client}>
        <IntlProvider locale="en" messages={messages.en} timeZone="UTC" now={new Date(0)}>
          {node}
        </IntlProvider>
      </QueryClientProvider>
    ),
  };
}

// Self-owned mode: a button on the page is the trigger.
function mountSelfOwned() {
  const { ui, client } = wrap(
    <AddAccountModal
      triggerRender={
        <button type="button" data-testid="trigger">
          open
        </button>
      }
    />,
  );
  return { ...render(ui), client };
}

const openModal = () => fireEvent.click(screen.getByTestId("trigger"));
// The accounts list cache must be marked stale after a write so the new account / balances show up.
const LIST = accountKeys.list("p1");
const seedList = (client: QueryClient) => client.setQueryData(LIST, []);
const listStale = (client: QueryClient) => client.getQueryState(LIST)?.isInvalidated === true;

// Grid cells' accessible names start with the logo's initials fallback, so match on the name's end.
const pick = async (label: string) =>
  fireEvent.click(await screen.findByRole("button", { name: new RegExp(`${label}$`) }));

beforeEach(() => {
  vi.clearAllMocks();
  document.body.innerHTML = "";
  getSpecs.mockResolvedValue(SPECS);
  listConnectors.mockImplementation(() => new Promise(() => {}));
});

describe("type grid ↔ form", () => {
  it("opens on the grid; clicking a type shows its form with its field specs", async () => {
    mountSelfOwned();
    openModal();
    await screen.findByRole("heading", { name: "Add account" });

    await pick("Binance");

    await waitFor(() =>
      expect(screen.getByTestId("account-form").textContent).toContain(
        "form:binance specs:apiKey,apiSecret",
      ),
    );
    expect(screen.getByRole("heading", { name: "Binance" })).toBeTruthy();
  });

  it("doesn't fetch field specs until opened", async () => {
    mountSelfOwned();
    await Promise.resolve();
    expect(getSpecs).not.toHaveBeenCalled();

    openModal();

    await waitFor(() => expect(getSpecs).toHaveBeenCalled());
  });

  it("back → returns to the grid", async () => {
    mountSelfOwned();
    openModal();
    await pick("EVM");
    await screen.findByTestId("account-form");

    fireEvent.click(screen.getByRole("button", { name: "Back to connectors" }));

    await waitFor(() => expect(screen.queryByTestId("account-form")).toBeNull());
    expect(screen.getByRole("heading", { name: "Add account" })).toBeTruthy();
  });

  it("close and reopen → starts at the grid, not the last form", async () => {
    mountSelfOwned();
    openModal();
    await pick("EVM");
    await screen.findByTestId("account-form");

    // Until the grid view's exit animation ends both headers are in the DOM — wait for just the form's.
    fireEvent.click(await waitFor(() => screen.getByRole("button", { name: "Close" })));
    await waitFor(() => expect(screen.queryByTestId("account-form")).toBeNull());
    openModal();

    await screen.findByRole("heading", { name: "Add account" });
    await waitFor(() => expect(screen.queryByTestId("account-form")).toBeNull());
  });
});

describe("after creating", () => {
  it("closes the modal and syncs the new account in the background", async () => {
    syncAccountAndWait.mockResolvedValue({ ok: true });
    const onOpenChange = vi.fn();
    const { ui, client } = wrap(<AddAccountModal open onOpenChange={onOpenChange} />);
    render(ui);
    await pick("EVM");

    fireEvent.click(await screen.findByRole("button", { name: "form-done" }));

    expect(onOpenChange).toHaveBeenCalledWith(false);
    await waitFor(() => expect(syncAccountAndWait).toHaveBeenCalledWith(client, "new_1"));
    expect(toastError).not.toHaveBeenCalled();
  });

  it("created → accounts list refreshes at once, and again after the background sync (balances in)", async () => {
    let finishSync: (v: unknown) => void = () => {};
    syncAccountAndWait.mockImplementation(
      () =>
        new Promise((r) => {
          finishSync = r;
        }),
    );
    const { ui, client } = wrap(<AddAccountModal open onOpenChange={vi.fn()} />);
    seedList(client);
    render(ui);
    await pick("EVM");

    fireEvent.click(await screen.findByRole("button", { name: "form-done" }));

    await waitFor(() => expect(listStale(client)).toBe(true));
    await waitFor(() => expect(syncAccountAndWait).toHaveBeenCalled());
    seedList(client); // list re-read with the new data
    expect(listStale(client)).toBe(false);

    finishSync({ ok: true });

    await waitFor(() => expect(listStale(client)).toBe(true));
  });

  it("background sync failure → shows the upstream message", async () => {
    syncAccountAndWait.mockResolvedValue({ ok: false, skipped: false, error: "rate limited" });
    const { ui } = wrap(<AddAccountModal open onOpenChange={vi.fn()} />);
    render(ui);
    await pick("EVM");
    fireEvent.click(await screen.findByRole("button", { name: "form-done" }));

    await waitFor(() => expect(toastError).toHaveBeenCalledWith("rate limited"));
  });

  it("background sync failure without a message → generic failure copy", async () => {
    syncAccountAndWait.mockResolvedValue({ ok: false, skipped: false });
    const { ui } = wrap(<AddAccountModal open onOpenChange={vi.fn()} />);
    render(ui);
    await pick("EVM");
    fireEvent.click(await screen.findByRole("button", { name: "form-done" }));

    await waitFor(() => expect(toastError).toHaveBeenCalledWith("Sync failed."));
  });

  it("sync skipped (e.g. manual account) → no error", async () => {
    syncAccountAndWait.mockResolvedValue({ ok: false, skipped: true });
    const { ui } = wrap(<AddAccountModal open onOpenChange={vi.fn()} />);
    render(ui);
    await pick("EVM");
    fireEvent.click(await screen.findByRole("button", { name: "form-done" }));

    await waitFor(() => expect(syncAccountAndWait).toHaveBeenCalled());
    await Promise.resolve();
    expect(toastError).not.toHaveBeenCalled();
  });
});

describe("add credentials", () => {
  const target = {
    accountId: "acc_9",
    connectorId: "binance" as const,
    credsSafe: { apiKey: "ab…yz" },
    missingCreds: ["secret"],
  };

  it("opens straight into the creds view: titled with the connector, form gets the account + masked hints", async () => {
    const { ui } = wrap(<AddAccountModal completeFor={target} onCompleteClose={vi.fn()} />);
    render(ui);

    await screen.findByRole("heading", { name: "Binance" });
    await waitFor(() =>
      expect(screen.getByTestId("cred-form").textContent).toContain(
        'cred:acc_9 specs:apiKey,apiSecret hint:{"apiKey":"ab…yz"}',
      ),
    );
    expect(screen.queryByRole("button", { name: "Back to connectors" })).toBeNull();
  });

  it("creds view title uses the connector's catalog name", async () => {
    const { ui } = wrap(<AddAccountModal completeFor={target} onCompleteClose={vi.fn()} />, {
      binance: { label: "Binance Global" },
    });
    render(ui);

    expect(await screen.findByRole("heading", { name: "Binance Global" })).toBeTruthy();
  });

  it("saved → toasts syncing, closes the creds view, syncs that account in the background", async () => {
    syncAccountAndWait.mockResolvedValue({ ok: true });
    const onCompleteClose = vi.fn();
    const { ui, client } = wrap(
      <AddAccountModal completeFor={target} onCompleteClose={onCompleteClose} />,
    );
    seedList(client);
    render(ui);

    fireEvent.click(await screen.findByRole("button", { name: "cred-done" }));

    expect(toastSuccess).toHaveBeenCalledWith("Saved, syncing…");
    expect(onCompleteClose).toHaveBeenCalled();
    // The account flips right away (no longer missing creds), without waiting for the sync.
    expect(listStale(client)).toBe(true);
    await waitFor(() => expect(syncAccountAndWait).toHaveBeenCalledWith(client, "acc_9"));
  });

  it("close → clears the creds target", async () => {
    const onCompleteClose = vi.fn();
    const { ui } = wrap(<AddAccountModal completeFor={target} onCompleteClose={onCompleteClose} />);
    render(ui);

    fireEvent.click(await screen.findByRole("button", { name: "Close" }));

    expect(onCompleteClose).toHaveBeenCalled();
    expect(syncAccountAndWait).not.toHaveBeenCalled();
  });
});
