import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { IntlProvider } from "use-intl";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { messages } from "@/lib/i18n/messages";
import { settingsKeys } from "@/lib/queries/keys";

// 设置页「数据」卡:导出链接 + 导入文件。
// 导入是一次真写库,所以要钉住**什么时候直接写、什么时候先问**:
// ① 库确认是空的 → 选完文件直接导;② 库里有数据 → 先弹「合并进已有数据?」,取消就不发请求;
// ③ 统计还没到(不知道空不空)→ 按「可能非空」处理,同样先问 —— 不在未知时直接写入。
// 以及导入的结果(条数 / 服务端原样的错误文本)要显示给用户。
const { getDataStats } = vi.hoisted(() => ({ getDataStats: vi.fn() }));

vi.mock("@/lib/server/settings", () => ({
  getDataStats,
  getDataVersion: vi.fn(),
  getProviderKeyStatus: vi.fn(),
  getValuationSettings: vi.fn(),
}));

const { DataCard } = await import("@/routes/_authed/-settings/data-card");

const fetchMock = vi.fn();

function mount(stats?: { hasData: boolean }) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  if (stats) client.setQueryData(settingsKeys.dataStats(), stats);
  const utils = render(
    <QueryClientProvider client={client}>
      <IntlProvider locale="en" messages={messages.en} timeZone="UTC" now={new Date(0)}>
        <DataCard />
      </IntlProvider>
    </QueryClientProvider>,
  );
  const fileInput = () => utils.container.querySelector('input[type="file"]') as HTMLInputElement;
  const pick = (file: File) => fireEvent.change(fileInput(), { target: { files: [file] } });
  return { ...utils, fileInput, pick };
}

const FILE = new File(['{"kind":"account"}\n'], "folio-export.ndjson", {
  type: "application/x-ndjson",
});

const okResponse = (body: unknown) =>
  ({ ok: true, json: async () => body, text: async () => JSON.stringify(body) }) as Response;

beforeEach(() => {
  vi.clearAllMocks();
  document.body.innerHTML = "";
  vi.stubGlobal("fetch", fetchMock);
  // 统计永远停在路上:要「已知」的用例自己 setQueryData,其余就是「还不知道」。
  getDataStats.mockImplementation(() => new Promise(() => {}));
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("导出", () => {
  it("导出是指向 /api/export 的下载链接", () => {
    mount({ hasData: true });
    const link = screen.getByRole("link", { name: "Export data" });
    expect(link.getAttribute("href")).toBe("/api/export");
    expect(link.hasAttribute("download")).toBe(true);
  });
});

describe("导入", () => {
  it("库是空的 → 选完文件直接 POST 到 /api/import,显示导入条数", async () => {
    fetchMock.mockResolvedValue(okResponse({ imported: { accounts: 2, snapshots: 5 } }));
    const { pick } = mount({ hasData: false });

    pick(FILE);

    await screen.findByText("Imported 2 account(s), 5 snapshot(s).");
    expect(fetchMock).toHaveBeenCalledWith("/api/import", { method: "POST", body: FILE });
    expect(screen.queryByText("Import into existing data?")).toBeNull();
  });

  it("库里有数据 → 先问,确认后才导", async () => {
    fetchMock.mockResolvedValue(okResponse({ imported: { accounts: 1, snapshots: 0 } }));
    const { pick } = mount({ hasData: true });

    pick(FILE);
    await screen.findByText("Import into existing data?");
    expect(fetchMock).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Import" }));

    await screen.findByText("Imported 1 account(s), 0 snapshot(s).");
    expect(fetchMock).toHaveBeenCalledWith("/api/import", { method: "POST", body: FILE });
  });

  it("库里有数据 → 取消就不发请求", async () => {
    const { pick } = mount({ hasData: true });

    pick(FILE);
    await screen.findByText("Import into existing data?");
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

    await waitFor(() => expect(screen.queryByText("Import into existing data?")).toBeNull());
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("统计还没到 → 按「可能非空」先问,不直接写", async () => {
    const { pick } = mount();

    pick(FILE);

    await screen.findByText("Import into existing data?");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("服务端拒绝 → 原样显示它的错误文本", async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      text: async () => "bad line 3: unknown kind",
    } as Response);
    const { pick } = mount({ hasData: false });

    pick(FILE);

    await screen.findByText("bad line 3: unknown kind");
  });

  it("导入在飞时按钮禁用并显示进行中", async () => {
    fetchMock.mockImplementation(() => new Promise(() => {}));
    const { pick } = mount({ hasData: false });

    pick(FILE);

    const busy = (await screen.findByRole("button", { name: "Verifying…" })) as HTMLButtonElement;
    expect(busy.disabled).toBe(true);
  });
});
