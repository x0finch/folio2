import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { IntlProvider } from "use-intl";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { messages } from "@/lib/i18n/messages";

const { listConnectors } = vi.hoisted(() => ({ listConnectors: vi.fn() }));
vi.mock("@/lib/server/connectors", () => ({
  listConnectors,
  getConnectorCredentialSpecs: vi.fn(),
}));

const { TabPinPicker } = await import("@/routes/_authed/-home/tab/pin-picker");

beforeEach(() => {
  listConnectors.mockReset();
  listConnectors.mockResolvedValue({
    binance: { label: "Binance", logo: "/api/logo/platform/binance" },
  });
});
afterEach(cleanup);

function mount(props: Partial<Parameters<typeof TabPinPicker>[0]> = {}) {
  const onPick = vi.fn();
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <IntlProvider locale="en" messages={messages.en} timeZone="UTC">
        <TabPinPicker
          connectorOptions={[]}
          tagOptions={[]}
          accountOptions={[]}
          onPick={onPick}
          {...props}
        />
      </IntlProvider>
    </QueryClientProvider>,
  );
  return onPick;
}

const options = () => screen.queryAllByRole("button").map((b) => b.textContent);

describe("three sections and the empty state", () => {
  it('all three sections empty: "Nothing to pin yet", no options at all', () => {
    mount();
    expect(screen.getByText("Nothing to pin yet")).toBeTruthy();
    expect(options()).toEqual([]);
  });

  it("with options no empty state; ordered Tags, Types, Accounts, each with its own mark", async () => {
    mount({
      tagOptions: [{ id: "t1", name: "DeFi" }],
      connectorOptions: [{ id: "binance", label: "ignored" }],
      accountOptions: [{ id: "a1", label: "Cold" }],
    });
    expect(screen.queryByText("Nothing to pin yet")).toBeNull();
    expect(screen.getByText("Tags")).toBeTruthy();
    expect(screen.getByText("Types")).toBeTruthy();
    expect(screen.getByText("Accounts")).toBeTruthy();
    const binance = await screen.findByRole("button", { name: "Binance" });
    expect(screen.getAllByRole("button")).toEqual([
      screen.getByRole("button", { name: "#DeFi" }),
      binance,
      screen.getByRole("button", { name: "@Cold" }),
    ]);
  });

  it("a section without options is omitted entirely (not even its heading)", () => {
    mount({ accountOptions: [{ id: "a1", label: "Cold" }] });
    expect(screen.queryByText("Tags")).toBeNull();
    expect(screen.queryByText("Types")).toBeNull();
    expect(screen.getByText("Accounts")).toBeTruthy();
  });
});

describe("clicking an item: callback receives the target", () => {
  it("tag: {kind: tag, tagId}", () => {
    const onPick = mount({ tagOptions: [{ id: "t1", name: "DeFi" }] });
    fireEvent.click(screen.getByRole("button", { name: "#DeFi" }));
    expect(onPick).toHaveBeenCalledWith({ kind: "tag", tagId: "t1" });
  });

  it("account: {kind: account, accountId}", () => {
    const onPick = mount({ accountOptions: [{ id: "a1", label: "Cold" }] });
    fireEvent.click(screen.getByRole("button", { name: "@Cold" }));
    expect(onPick).toHaveBeenCalledWith({ kind: "account", accountId: "a1" });
  });

  it("connector: {kind: connector, connectorId}", async () => {
    const onPick = mount({ connectorOptions: [{ id: "binance", label: "Binance" }] });
    fireEvent.click(await screen.findByRole("button", { name: "Binance" }));
    expect(onPick).toHaveBeenCalledWith({ kind: "connector", connectorId: "binance" });
  });
});
