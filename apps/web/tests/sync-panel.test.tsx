import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render } from "@testing-library/react";
import { IntlProvider } from "use-intl";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { messages } from "@/lib/i18n/messages";
import type { SyncRoundView, SyncStatusSummary } from "@/lib/server/sync/status";

// 同步面板的**口径**(ADR 0048 裁定 7):三段式 —— synced · failed · need keys,每个词各管各的,
// 为 0 的段省略;进行中改成 `x / N · 正在同步谁`。
//
// 它替掉的是一个合成分子(不参与同步的来源打底 + 本轮完成 - 跳过)夹在 `summary.total` 上的式子。
// 那个式子每修一次口径就要多一句注释,因为它想让一个数同时回答三个不同的问题:失败的账户算不算
// 已同步、缺凭据的算不算跑过、旧数算不算数。三个词一摆,这些问题不再需要答案。
//
// 连接器目录用假的:面板只拿它把 connectorId 换成展示名,而它背后是个 server fn。
vi.mock("@/lib/server/connectors", () => ({
  listConnectors: vi.fn(async () => ({})),
  getConnectorCredentialSpecs: vi.fn(),
}));
// 同理:面板经 `use-sync-round` 拉进同步域的 server fn,而那条 import 链一路通到
// `cloudflare:workers`(生产里由 Start 编译器从客户端 bundle 剥离,vitest 不会)。
vi.mock("@/lib/server/sync", () => ({
  getSyncRound: vi.fn(),
}));

const { SyncPanel, hasAttention } = await import("@/components/sync-status");

const NOW = 1_700_000_000_000;
const MINUTE = 60_000;

// 13 个来源、9 个可同步 —— 生产截图里那一组数,四个不参与同步的(手记等)就是 synced 那段的打底。
const summary = (over: Partial<SyncStatusSummary> = {}): SyncStatusSummary => ({
  accounts: Array.from({ length: 9 }, (_, i) => ({ id: `a${i}`, label: `Acc ${i}` })),
  total: 13,
  attention: [],
  lastSyncedAt: NOW - 2 * MINUTE,
  ...over,
});

const round = (over: Partial<SyncRoundView> = {}): SyncRoundView => ({
  roundId: "r1",
  state: "done",
  trigger: "manual",
  startedAt: NOW - 30_000,
  finishedAt: NOW - 1_000,
  total: 9,
  settled: 9,
  synced: 9,
  failed: [],
  needsKeys: 0,
  current: null,
  unresolved: 0,
  error: null,
  ...over,
});

// 相对时间经 useRelativeSyncedAt 走**真实系统时钟**(挂载后立刻对表,见那个 hook 的注释),
// 所以把系统时钟钉在 NOW —— 不钉的话「2 minutes ago」会随跑测试的日期漂移。
beforeEach(() => {
  vi.useFakeTimers({ now: NOW });
});
afterEach(() => {
  vi.useRealTimers();
});

function mount(props: {
  summary: SyncStatusSummary;
  round: SyncRoundView | null;
  startError?: string | null;
}) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const { container } = render(
    <QueryClientProvider client={client}>
      <IntlProvider locale="en" messages={messages.en} timeZone="UTC" now={new Date(NOW)}>
        <SyncPanel
          summary={props.summary}
          round={props.round}
          startError={props.startError ?? null}
          onSync={() => {}}
          onPick={() => {}}
        />
      </IntlProvider>
    </QueryClientProvider>,
  );
  return container.textContent ?? "";
}

describe("三段式口径", () => {
  it("全都成功 → 只有 synced 一段,数上不参与同步的来源", () => {
    // 本轮成功 9 + 不参与同步的 4 = 13。
    const text = mount({ summary: summary(), round: round() });
    expect(text).toContain("13 synced");
    expect(text).toContain("All synced");
    expect(text).not.toContain("failed");
    expect(text).not.toContain("need keys");
  });

  it("三段都有 → 三个数各归各的,谁也不吞谁", () => {
    const text = mount({
      summary: summary(),
      round: round({
        synced: 6,
        needsKeys: 2,
        failed: [{ accountId: "a1", label: "OKX main", error: "invalid api key" }],
      }),
    });
    expect(text).toContain("10 synced"); // 6 + 4 个不参与同步的
    expect(text).toContain("1 failed");
    expect(text).toContain("2 need keys");
  });

  // 读不到轮 = **还没跑过**,不是「跑过了、成绩是这些」。第一版在这种时候拿手记的条数硬凑了一个
  // 数,于是新账号那一刻面板写着 `This round: 2 synced`、页头写着 across 10 sources —— 读起来
  // 像「10 个来源只同步上 2 个」,比什么都不说还糟。无轮态只说 `Last updated` 与清单。
  it("压根没有轮 → 不出现「本轮」那一行", () => {
    const text = mount({ summary: summary(), round: null });
    expect(text).not.toContain("This round");
  });

  // 断言的是「不报某一轮的数」,不是「不出现 synced 这个词」—— 徽标那句 All synced 说的是当下
  // 状态,与某一轮无关,它该留着(没有需要注意的来源时它就是绿的)。
  it("压根没有轮 → 一个 x/y 或「N synced」都不报", () => {
    const text = mount({ summary: summary(), round: null });
    expect(text).not.toMatch(/\d+\s*(synced|failed|need keys)/);
    expect(text).not.toMatch(/\d+\s*\/\s*\d+/);
    // 该说的还得说:上次更新那一行照旧。
    expect(text).toContain("2 minutes ago");
  });

  // 无轮态那一行说的是「这个组合有几个来源」——**一个整数,不是分数**。写成分数读的人会当成
  // 「同步上几个」,而这一态恰恰是「还没跑过」。它天然随组合变,页头摘要跟着选中组合走这件事
  // 也靠它在 e2e 里当锚点(见 e2e/portfolio-url.spec.ts)。
  it("压根没有轮 → 报这个组合的来源数(含手记),不是分数", () => {
    const text = mount({ summary: summary(), round: null });
    expect(text).toContain("Sources");
    expect(text).toContain("13");
  });

  // 轮中归档一个已同步的账户:summary 被定向刷新后 total 缩水(13 → 12、可同步 9 → 8),
  // 而这一轮照旧回 9 条 —— 打底 4 + 本轮 9 = 13 > 12,读起来像多同步出一个来源。夹在分母上。
  it("轮中归档 → synced 段夹在来源总数上,不出现 13 synced / 12 来源", () => {
    const s = summary({
      accounts: Array.from({ length: 8 }, (_, i) => ({ id: `a${i}`, label: `Acc ${i}` })),
      total: 12,
    });
    const text = mount({ summary: s, round: round({ synced: 9, settled: 9 }) });
    expect(text).toContain("12 synced");
    expect(text).not.toContain("13 synced");
  });

  it("有轮时那一行是三段式,不掺来源数", () => {
    const text = mount({ summary: summary(), round: round() });
    expect(text).toContain("This round");
    expect(text).not.toContain("Sources");
  });

  it("同步中 → `x / N` 与正在同步谁,不出现收官后那一行", () => {
    const text = mount({
      summary: summary(),
      round: round({
        state: "running",
        finishedAt: null,
        settled: 3,
        synced: 3,
        current: "Kraken",
      }),
    });
    expect(text).toContain("3 / 9");
    expect(text).toContain("Now syncing");
    expect(text).toContain("Kraken");
    expect(text).toContain("Syncing");
    expect(text).not.toContain("This round");
  });
});

describe("上次更新", () => {
  it("同步中照样是上次成功同步的时间,不是 —", () => {
    const text = mount({
      summary: summary(),
      round: round({ state: "running", finishedAt: null, settled: 1 }),
    });
    expect(text).toContain("2 minutes ago");
    expect(text).not.toContain("—");
  });

  it("快照比 now 还新(刚落库、时钟没 tick 到)→ 钳到 now,绝不渲染未来时态", () => {
    const text = mount({ summary: summary({ lastSyncedAt: NOW + 2 * MINUTE }), round: round() });
    expect(text).toContain("now");
    expect(text).not.toContain("in 2 minutes");
  });

  it("从未同步过 → 说「Never」", () => {
    expect(mount({ summary: summary({ lastSyncedAt: null }), round: null })).toContain("Never");
  });
});

describe("出了事的那一块", () => {
  it("失败逐条出现:账户名 + 上游原话", () => {
    const text = mount({
      summary: summary(),
      round: round({
        synced: 8,
        failed: [{ accountId: "a1", label: "OKX main", error: "invalid api key" }],
      }),
    });
    expect(text).toContain("Failed this round");
    expect(text).toContain("OKX main");
    expect(text).toContain("invalid api key");
  });

  it("整轮没跑起来 → 那句话留在面板上,徽标转琥珀", () => {
    const text = mount({
      summary: summary(),
      round: round({ synced: 0, error: "listAccounts blew up" }),
    });
    expect(text).toContain("listAccounts blew up");
    expect(text).toContain("Needs attention");
    expect(text).not.toContain("All synced");
  });

  // 中断没有清单可列(一个账户结果都没有),但它必须说话 —— 不然一轮假同步在面板上与
  // 「一切正常」长得一模一样,而屏幕上的数是旧的。
  it("中断 → 说一句「上一轮没跑完」,徽标转琥珀", () => {
    const text = mount({
      summary: summary(),
      round: round({ state: "interrupted", finishedAt: null, settled: 2, synced: 2 }),
    });
    expect(text).toContain("stopped partway");
    expect(text).toContain("Needs attention");
  });

  // 发起请求就没成功(掉线、401):它不是「这一轮里某个账户失败了」,那时压根没有这一轮。
  it("发起同步失败 → 单独一句,不冒充某个账户的失败", () => {
    const text = mount({ summary: summary(), round: null, startError: "sync failed: 401" });
    expect(text).toContain("Couldn't start the sync");
    expect(text).toContain("sync failed: 401");
    expect(text).toContain("Needs attention");
  });

  it("需要注意的来源照旧逐条列出", () => {
    const text = mount({
      summary: summary({
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
    });
    expect(text).toContain("Missing credentials");
  });
});

// pill 转琥珀的那条推导。SyncStatus 里以前是内联表达式,零覆盖 —— 删掉任何一半,上面那些
// 面板测试照样绿(它们看的是面板文字,不是这条判据本身)。纯函数直接喂数据。
describe("hasAttention", () => {
  it("摘要没事、这一轮也没事 → false", () => {
    expect(hasAttention(summary(), round())).toBe(false);
  });

  it("压根没有轮 → false(从没同步过不是「有事」,那件事走清单)", () => {
    expect(hasAttention(summary(), null)).toBe(false);
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
        round({ failed: [{ accountId: "a1", label: "OKX", error: "invalid api key" }] }),
      ),
    ).toBe(true);
  });

  it("整轮没跑起来 → true", () => {
    expect(hasAttention(summary(), round({ error: "listAccounts blew up" }))).toBe(true);
  });

  it("中断 → true(它连结果都没有,摘要更看不见)", () => {
    expect(hasAttention(summary(), round({ state: "interrupted", finishedAt: null }))).toBe(true);
  });

  it("发起同步就失败了 → true", () => {
    expect(hasAttention(summary(), null, "sync failed: 401")).toBe(true);
  });
});
