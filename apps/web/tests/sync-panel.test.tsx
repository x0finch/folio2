import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render } from "@testing-library/react";
import { IntlProvider } from "use-intl";
import { describe, expect, it, vi } from "vitest";
import type { SyncRound } from "@/lib/hooks/use-account-sync";
import { messages } from "@/lib/i18n/messages";
import type { SyncStatusSummary } from "@/lib/server/sync/status";

// 同步面板的**口径**(FOL-32 裁定 3):屏幕上只有一个数,分母永远是「组合内全部来源」。
//
// 三条症状都出在这张面板上:顶上一条 toast 写 `7/9`、面板同时写 `13/13`(两套分母同屏);
// 状态写着 Syncing、数字却是 `13/13`(自相矛盾);而 `Last updated` 在 busy 时被写死成 `—`,
// 恰好在最该看它的那一刻把它抹掉 —— 正在同步 = 屏幕上的数还是旧的,「旧到什么时候」是唯一有用的信息。
//
// 连接器目录用假的:面板只拿它把 connectorId 换成展示名,而它背后是个 server fn。
vi.mock("@/lib/server/connectors", () => ({
  listConnectors: vi.fn(async () => ({})),
  getConnectorCredentialSpecs: vi.fn(),
}));

const { SyncPanel, hasAttention } = await import("@/components/sync-status");

const NOW = 1_700_000_000_000;
const MINUTE = 60_000;

// 13 个来源、9 个可同步 —— 生产截图里那一组数,四个不参与同步的(手记等)就是分子的打底。
const summary = (over: Partial<SyncStatusSummary> = {}): SyncStatusSummary => ({
  accounts: Array.from({ length: 9 }, (_, i) => ({ id: `a${i}`, label: `Acc ${i}` })),
  total: 13,
  ok: 13,
  attention: [],
  lastSyncedAt: NOW - 2 * MINUTE,
  ...over,
});

const round = (over: Partial<SyncRound> = {}): SyncRound => ({
  done: 0,
  total: 0,
  current: null,
  failures: [],
  error: null,
  ...over,
});

function mount(props: {
  summary: SyncStatusSummary;
  round: SyncRound;
  busy: boolean;
  needsAttention?: boolean;
}) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const { container } = render(
    <QueryClientProvider client={client}>
      <IntlProvider locale="en" messages={messages.en} timeZone="UTC" now={new Date(NOW)}>
        <SyncPanel
          summary={props.summary}
          round={props.round}
          busy={props.busy}
          needsAttention={props.needsAttention ?? false}
          onSync={() => {}}
          onPick={() => {}}
        />
      </IntlProvider>
    </QueryClientProvider>,
  );
  return container.textContent ?? "";
}

describe("SyncPanel 的口径", () => {
  it("没在同步 → 摘要那两个数原样(ok / total)", () => {
    const text = mount({ summary: summary(), round: round(), busy: false });
    expect(text).toContain("13 / 13");
    expect(text).toContain("All synced");
  });

  it("同步中 → 分子 =(不参与同步的来源)+ 本轮已完成,分母仍是全部来源", () => {
    // 13 - 9 = 4 个不参与这一轮的来源打底;本轮完成 3 个 → 7 / 13。
    const text = mount({ summary: summary(), round: round({ done: 3, total: 9 }), busy: true });
    expect(text).toContain("7 / 13");
    // 旧的小分母(本轮 3/9)不该出现在任何地方 —— 它正是那条 toast 说的话。
    expect(text).not.toContain("3 / 9");
    expect(text).toContain("Syncing");
  });

  it("一轮从「打底」起步、到「满」收口 —— 中间没有别的分母", () => {
    const s = summary();
    expect(mount({ summary: s, round: round({ done: 0, total: 9 }), busy: true })).toContain(
      "4 / 13",
    );
    expect(mount({ summary: s, round: round({ done: 9, total: 9 }), busy: true })).toContain(
      "13 / 13",
    );
  });

  it("轮中有账户被归档 → 分子夹在分母上,不出现 13 / 12", () => {
    // summary 每完成一个账户就被定向刷新:轮中归档一个已同步账户,total 缩成 12、可同步缩成 8,
    // 而这一轮照旧回 9 条 —— 打底 4 + 完成 9 = 13 > 12。
    const s = summary({
      accounts: Array.from({ length: 8 }, (_, i) => ({ id: `a${i}`, label: `Acc ${i}` })),
      total: 12,
      ok: 12,
    });
    const text = mount({ summary: s, round: round({ done: 9, total: 9 }), busy: true });
    expect(text).toContain("12 / 12");
    expect(text).not.toContain("13 / 12");
  });

  it("同步中 Last updated 仍是上次成功同步的时间,不是 —", () => {
    const text = mount({ summary: summary(), round: round({ done: 1, total: 9 }), busy: true });
    expect(text).toContain("2 minutes ago");
    expect(text).not.toContain("—");
  });

  it("从未同步过 → Last updated 说「Never」(busy 与否都一样)", () => {
    const s = summary({ lastSyncedAt: null });
    expect(mount({ summary: s, round: round(), busy: false })).toContain("Never");
    expect(mount({ summary: s, round: round({ done: 1, total: 9 }), busy: true })).toContain(
      "Never",
    );
  });

  it("同步中报出当前正在同步的账户名", () => {
    const text = mount({
      summary: summary(),
      round: round({ done: 2, total: 9, current: "Bitget 现货主号" }),
      busy: true,
    });
    expect(text).toContain("Now syncing");
    expect(text).toContain("Bitget 现货主号");
  });

  it("失败逐条出现:账户名 + 上游原话", () => {
    const text = mount({
      summary: summary(),
      round: round({
        done: 2,
        total: 9,
        failures: [{ accountId: "a1", label: "OKX main", error: "invalid api key" }],
      }),
      busy: true,
      needsAttention: true,
    });
    expect(text).toContain("Failed this round");
    expect(text).toContain("OKX main");
    expect(text).toContain("invalid api key");
  });

  it("整轮没跑起来 → 那句话也留在面板上,不随 busy 落回而消失", () => {
    const text = mount({
      summary: summary(),
      round: round({ error: "listAccounts blew up" }),
      busy: false,
      needsAttention: true,
    });
    expect(text).toContain("listAccounts blew up");
    // 有事要看一眼 → 徽标不该还绿着说「全部同步」。
    expect(text).toContain("Needs attention");
    expect(text).not.toContain("All synced");
  });

  it("需要注意的来源照旧逐条列出", () => {
    const text = mount({
      summary: summary({
        ok: 12,
        attention: [
          {
            id: "z",
            label: "Zerion",
            connectorId: "evm",
            kind: "missing-credentials",
            takenAt: null,
          },
        ],
      }),
      round: round(),
      busy: false,
      needsAttention: true,
    });
    expect(text).toContain("Missing credentials");
    expect(text).toContain("12 / 13");
  });
});

// pill 转琥珀的那条推导。SyncStatus 里以前是内联表达式,零覆盖 —— 删掉「本轮失败也算」那一半,
// 上面那些注入 needsAttention 的面板测试照样绿。纯函数直接喂数据。
describe("hasAttention", () => {
  it("摘要没事、这一轮也没事 → false", () => {
    expect(hasAttention(summary(), round())).toBe(false);
  });

  it("摘要清单非空 → true", () => {
    expect(
      hasAttention(
        summary({
          attention: [
            { id: "z", label: "Z", connectorId: "evm", kind: "missing-credentials", takenAt: null },
          ],
        }),
        round(),
      ),
    ).toBe(true);
  });

  it("本轮有失败 → true —— 摘要看不见这种失败(账户往往仍有旧快照、凭据也齐)", () => {
    expect(
      hasAttention(
        summary(),
        round({ failures: [{ accountId: "a1", label: "OKX", error: "invalid api key" }] }),
      ),
    ).toBe(true);
  });

  it("整轮没跑起来 → true", () => {
    expect(hasAttention(summary(), round({ error: "listAccounts blew up" }))).toBe(true);
  });
});
