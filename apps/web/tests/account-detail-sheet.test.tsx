import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { IntlProvider } from "use-intl";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { rangeSince } from "@/lib/core/history-range";
import { messages } from "@/lib/i18n/messages";
import type { AccountRow } from "@/routes/_authed/-accounts/list-rows";

// Account detail sheet: header, overflow menu and inline rename.
// The chart and holdings list are stubbed; we only check what the sheet hands them.
const {
  archiveAccount,
  removeAccount,
  renameAccount,
  getAccountHistory,
  syncAccountAndWait,
  toastError,
  toastSuccess,
  toastMessage,
} = vi.hoisted(() => ({
  archiveAccount: vi.fn(),
  removeAccount: vi.fn(),
  renameAccount: vi.fn(),
  getAccountHistory: vi.fn(),
  syncAccountAndWait: vi.fn(),
  toastError: vi.fn(),
  toastSuccess: vi.fn(),
  toastMessage: vi.fn(),
}));

const never = () => new Promise(() => {});
vi.mock("@/lib/server/accounts", () => ({
  archiveAccount,
  removeAccount,
  renameAccount,
  getAccountHistory,
  listAccounts: vi.fn(never),
}));
vi.mock("@/lib/server/connectors", () => ({
  listConnectors: vi.fn(never),
  getConnectorCredentialSpecs: vi.fn(never),
}));
vi.mock("@/lib/server/holdings", () => ({ getTokenValueHistory: vi.fn(never) }));
vi.mock("@/lib/server/manual-tokens", () => ({ getManualAccount: vi.fn(never) }));
vi.mock("@/lib/server/preferences", () => ({ getCurrencyPreference: vi.fn(never) }));
vi.mock("@/lib/queries/account-sync", () => ({ syncAccountAndWait }));
vi.mock("@folio/ui", async (orig) => ({
  ...(await orig<object>()),
  toast: { error: toastError, success: toastSuccess, message: toastMessage },
}));
vi.mock("@/routes/_authed/-home/hero/trend-panel", () => ({ TrendPanel: () => null }));
vi.mock("@/components/holdings-cards", () => ({
  AccountHoldingsCards: () => <div data-testid="holdings-cards" />,
}));
vi.mock("@/components/manual-tokens-panel", () => ({
  ManualTokensPanel: ({ accountId }: { accountId: string }) => (
    <div data-testid="manual-panel">{accountId}</div>
  ),
}));
vi.mock("@/components/portfolio-picker-modal", () => ({
  PortfolioPickerModal: (p: { open: boolean; accountId: string; currentPortfolioId: string }) =>
    p.open ? <div data-testid="move-modal">{`${p.accountId}@${p.currentPortfolioId}`}</div> : null,
}));
vi.mock("@/components/account-tags-modal", () => ({
  AccountTagsModal: (p: {
    open: boolean;
    portfolioTags: { id: string }[];
    attachedTagIds: string[];
    tagAccountCounts: Record<string, number>;
  }) =>
    p.open ? (
      <div data-testid="tags-modal">
        {JSON.stringify({
          tags: p.portfolioTags.map((t) => t.id),
          attached: p.attachedTagIds,
          counts: p.tagAccountCounts,
        })}
      </div>
    ) : null,
}));

const { AccountDetailSheet } = await import("@/routes/_authed/-accounts/account-detail-sheet");

const HOUR = 3_600_000;
const NOW = Date.now();
const SEALED = Date.UTC(2025, 0, 2);

const row = (over: Partial<AccountRow> = {}): AccountRow => ({
  id: "acc_1",
  label: "Main wallet",
  connectorId: "evm",
  archivedAt: null,
  valuesReady: true,
  totalUsd: 500,
  takenAt: NOW - HOUR,
  balances: [],
  gain24h: { amount: 12.34, pct: 1.5 },
  needsCredentials: false,
  credsSafe: {},
  portfolioId: "p1",
  tags: [],
  ...over,
});

const TAGS = [
  { id: "t1", name: "cold", portfolioId: "p1" },
  { id: "t2", name: "hot", portfolioId: "p1" },
  { id: "tX", name: "other", portfolioId: "p2" },
];
const LINKS = [
  { accountId: "acc_1", tagId: "t1" },
  { accountId: "acc_2", tagId: "t1" },
  { accountId: "acc_2", tagId: "t2" },
];

function mount(account: AccountRow, opts: { total?: number } = {}) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const onOpenChange = vi.fn();
  const onComplete = vi.fn();
  const utils = render(
    <QueryClientProvider client={client}>
      <IntlProvider locale="en" messages={messages.en} timeZone="UTC" now={new Date(NOW)}>
        <AccountDetailSheet
          account={account}
          total={opts.total ?? 1_000}
          allTags={TAGS as never}
          tagLinks={LINKS as never}
          open
          onOpenChange={onOpenChange}
          onComplete={onComplete}
        />
      </IntlProvider>
    </QueryClientProvider>,
  );
  return { ...utils, client, onOpenChange, onComplete };
}

// The menu opens on hover; clicking the trigger also opens it (the touch path).
async function menuItem(name: string | RegExp) {
  fireEvent.click(screen.getByRole("button", { name: "More actions" }));
  return (await screen.findByRole("button", { name })) as HTMLButtonElement;
}

beforeEach(() => {
  vi.clearAllMocks();
  document.body.innerHTML = "";
  getAccountHistory.mockResolvedValue({ rows: [], live: null, sampled: false });
});

describe("header", () => {
  it("active account: name, 24h change, share, last sync", async () => {
    mount(row());
    expect(screen.getByText("Main wallet")).toBeTruthy();
    expect(screen.getByText(/1\.50%/)).toBeTruthy();
    expect(screen.getByText(/50\.0% of total/)).toBeTruthy();
    expect(screen.getByText(/Synced/)).toBeTruthy();
  });

  it("archived: shows the archived badge and date, no 24h or share", () => {
    mount(row({ archivedAt: SEALED }));
    expect(screen.getByText("Archived")).toBeTruthy();
    expect(screen.getByText(/Sealed Jan 2, 25/)).toBeTruthy();
    expect(screen.queryByText(/of total/)).toBeNull();
    expect(screen.queryByText(/1\.50%/)).toBeNull();
  });

  it("24h loss → amount gets the minus sign, percent shows magnitude only", () => {
    mount(row({ gain24h: { amount: -12.34, pct: -1.5 } }));
    expect(screen.getByText(/1\.50%/)).toBeTruthy();
    expect(screen.queryByText(/-1\.50%/)).toBeNull();
  });

  it("archived manual account → shows the archive date, not 'live'", () => {
    mount(row({ connectorId: "manual", archivedAt: SEALED }));
    expect(screen.getByText(/Sealed Jan 2, 25/)).toBeTruthy();
    expect(screen.queryByText(/Live/)).toBeNull();
  });

  it("manual account → 'live', holdings use the manual panel", () => {
    mount(row({ connectorId: "manual" }));
    expect(screen.getByText(/Live/)).toBeTruthy();
    expect(screen.getByTestId("manual-panel").textContent).toBe("acc_1");
    expect(screen.queryByTestId("holdings-cards")).toBeNull();
  });

  it("never synced → 'never synced', holdings use the generic card", () => {
    mount(row({ takenAt: null }));
    expect(screen.getByText(/Never synced/)).toBeTruthy();
    expect(screen.getByTestId("holdings-cards")).toBeTruthy();
  });

  it("24h expected but not computable → shows —", () => {
    mount(row({ gain24h: null }));
    expect(screen.getByText("—")).toBeTruthy();
  });

  it("missing creds: no 24h; 'add credentials' hands back this account", () => {
    const account = row({ needsCredentials: true });
    const { onComplete } = mount(account);
    expect(screen.queryByText(/1\.50%/)).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Click to add credentials" }));

    expect(onComplete).toHaveBeenCalledWith(account);
  });

  it("values not loaded → skeleton: no sync time, holdings or share", () => {
    mount(row({ valuesReady: false }));
    expect(screen.queryByText(/Synced/)).toBeNull();
    // Value slot is a skeleton: no 24h line (that would treat the placeholder 0 as real).
    expect(screen.queryByText(/1\.50%/)).toBeNull();
    expect(screen.queryByText(/of total/)).toBeNull();
    expect(screen.queryByTestId("holdings-cards")).toBeNull();
  });
});

describe("value history window", () => {
  it("active account: defaults to 30 days, passes account and connector", async () => {
    mount(row());
    await waitFor(() => expect(getAccountHistory).toHaveBeenCalled());
    const data = getAccountHistory.mock.calls[0]?.[0].data;
    expect(data).toMatchObject({ accountId: "acc_1", range: "30d", connectorId: "evm" });
    // Start is relative to now, not anchored at a past moment.
    expect(
      Math.abs((data.since as number) - (rangeSince("30d", Date.now()) as number)),
    ).toBeLessThan(60_000);
  });

  it("archived account: window counts back from the archive moment", async () => {
    mount(row({ archivedAt: SEALED }));
    await waitFor(() => expect(getAccountHistory).toHaveBeenCalled());
    expect(getAccountHistory.mock.calls[0]?.[0].data.since).toBe(rangeSince("30d", SEALED));
  });

  it("switching to 7D refetches with a 7-day window", async () => {
    mount(row());
    await waitFor(() => expect(getAccountHistory).toHaveBeenCalled());

    fireEvent.click(screen.getByRole("tab", { name: "7D" }));

    await waitFor(() =>
      expect(getAccountHistory).toHaveBeenLastCalledWith({
        data: expect.objectContaining({ accountId: "acc_1", range: "7d" }),
      }),
    );
  });
});

describe("overflow menu: sync", () => {
  it("success → syncs this account and toasts synced", async () => {
    syncAccountAndWait.mockResolvedValue({ ok: true });
    const { client } = mount(row());
    fireEvent.click(await menuItem("Sync"));

    await waitFor(() => expect(toastSuccess).toHaveBeenCalledWith("Synced 1 account."));
    expect(syncAccountAndWait).toHaveBeenCalledWith(client, "acc_1");
  });

  it("skipped for missing creds → tells the user creds are missing", async () => {
    syncAccountAndWait.mockResolvedValue({
      ok: false,
      skipped: true,
      skipReason: "missing-credentials",
    });
    mount(row());
    fireEvent.click(await menuItem("Sync"));

    await waitFor(() =>
      expect(toastMessage).toHaveBeenCalledWith(
        "Nothing synced — this account is still missing credentials.",
      ),
    );
  });

  it("failure → shows the upstream message", async () => {
    syncAccountAndWait.mockResolvedValue({ ok: false, skipped: false, error: "429 from upstream" });
    mount(row());
    fireEvent.click(await menuItem("Sync"));

    await waitFor(() => expect(toastError).toHaveBeenCalledWith("429 from upstream"));
  });

  it("request itself fails (network) → generic failure copy", async () => {
    syncAccountAndWait.mockRejectedValue(new Error("network"));
    mount(row());
    fireEvent.click(await menuItem("Sync"));

    await waitFor(() => expect(toastError).toHaveBeenCalledWith("Sync failed."));
  });

  it("manual account has no sync item", async () => {
    mount(row({ connectorId: "manual" }));
    await menuItem("Archive");
    expect(screen.queryByRole("button", { name: "Sync" })).toBeNull();
  });

  it("sync is disabled for archived accounts", async () => {
    mount(row({ archivedAt: SEALED }));
    expect((await menuItem("Sync")).disabled).toBe(true);
  });
});

describe("overflow menu: archive / tags / move", () => {
  it("active account → archive", async () => {
    archiveAccount.mockResolvedValue(undefined);
    mount(row());
    fireEvent.click(await menuItem("Archive"));
    await waitFor(() =>
      expect(archiveAccount).toHaveBeenCalledWith({ data: { accountId: "acc_1", archived: true } }),
    );
  });

  it("archived account → item becomes unarchive", async () => {
    archiveAccount.mockResolvedValue(undefined);
    mount(row({ archivedAt: SEALED }));
    fireEvent.click(await menuItem("Unarchive"));
    await waitFor(() =>
      expect(archiveAccount).toHaveBeenCalledWith({
        data: { accountId: "acc_1", archived: false },
      }),
    );
  });

  it("archive failure → error toast", async () => {
    archiveAccount.mockRejectedValue(new Error("boom"));
    mount(row());
    fireEvent.click(await menuItem("Archive"));
    await waitFor(() => expect(toastError).toHaveBeenCalledWith("Action failed."));
  });

  it("tags → modal gets this portfolio's tags, the account's tags and per-tag account counts", async () => {
    mount(row());
    fireEvent.click(await menuItem("Tags"));
    expect(JSON.parse(screen.getByTestId("tags-modal").textContent ?? "")).toEqual({
      tags: ["t1", "t2"],
      attached: ["t1"],
      counts: { t1: 2, t2: 1 },
    });
  });

  it("move → portfolio picker gets this account and its current portfolio", async () => {
    mount(row());
    fireEvent.click(await menuItem("Move to…"));
    expect(screen.getByTestId("move-modal").textContent).toBe("acc_1@p1");
  });
});

describe("delete", () => {
  async function confirmDelete() {
    fireEvent.click(await menuItem("Delete"));
    await screen.findByText(/Delete this account\?/);
    const buttons = screen.getAllByRole("button", { name: "Delete" });
    fireEvent.click(buttons[buttons.length - 1] as HTMLElement);
  }

  it("menu delete only opens a confirmation, does not delete", async () => {
    mount(row());
    fireEvent.click(await menuItem("Delete"));
    await screen.findByText(/Delete this account\?/);
    expect(removeAccount).not.toHaveBeenCalled();
  });

  it("cancel in the confirmation → closes it, no delete", async () => {
    mount(row());
    fireEvent.click(await menuItem("Delete"));
    await screen.findByText(/Delete this account\?/);

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

    await waitFor(() => expect(screen.queryByText(/Delete this account\?/)).toBeNull());
    expect(removeAccount).not.toHaveBeenCalled();
  });

  it("confirm → deletes this account and closes the sheet on success", async () => {
    removeAccount.mockResolvedValue(undefined);
    const { onOpenChange } = mount(row());
    await confirmDelete();

    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
    expect(removeAccount).toHaveBeenCalledWith({ data: { accountId: "acc_1" } });
  });

  it("delete failure → error toast, sheet stays open", async () => {
    removeAccount.mockRejectedValue(new Error("boom"));
    const { onOpenChange } = mount(row());
    await confirmDelete();

    await waitFor(() => expect(toastError).toHaveBeenCalledWith("Action failed."));
    expect(onOpenChange).not.toHaveBeenCalled();
  });
});

describe("inline rename", () => {
  async function rename(to: string) {
    fireEvent.click(screen.getByText("Main wallet"));
    const input = (await screen.findByDisplayValue("Main wallet")) as HTMLInputElement;
    fireEvent.change(input, { target: { value: to } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
  }

  it("rename → writes the new name and exits edit mode on success", async () => {
    renameAccount.mockResolvedValue(undefined);
    mount(row());
    await rename("Cold storage");

    await waitFor(() =>
      expect(renameAccount).toHaveBeenCalledWith({
        data: { accountId: "acc_1", label: "Cold storage" },
      }),
    );
    await waitFor(() => expect(screen.queryByRole("button", { name: "Save" })).toBeNull());
  });

  it("rename failure → error toast and stays in the input", async () => {
    renameAccount.mockRejectedValue(new Error("boom"));
    mount(row());
    await rename("Cold storage");

    await waitFor(() => expect(toastError).toHaveBeenCalledWith("Action failed."));
    expect(screen.getByDisplayValue("Cold storage")).toBeTruthy();
  });
});
