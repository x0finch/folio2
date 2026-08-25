import type { ConnectorId } from "@folio/connectors";

// 「一个账户的同步状态」—— 账户列表那一行(`-accounts/index.tsx`)和页头那块同步面板**共用这一份**。
//
// 住在这儿而不是单开一个共享文件:这个概念属于同步状态,而这个模块就是同步状态的派生层,本来就
// 是纯的(无 cloudflare env)、本来就被客户端引着。为三行规则另立一个 `lib/core/*` 只是把一件事
// 拆成两个文件。**代价是这个文件必须一直保持纯净** —— 一旦有人往里加 server-only 的 import,
// 账户列表那一侧就炸,所以别加。
//
// 以前这条规则住在 `-accounts/list-rows.ts`(24 小时),而这里另有一条 7 天的(#527 裁定 8 的
// 第一版)。两个阈值同时在,于是账户行上挂着警示三角的同时,页头徽标可以正说「全部同步」——
// 那正是「数旧了要看得见」这件事想避免的自相矛盾。一份规则、两处读,阈值 3 天(手动同步的自用
// 工具,24 小时太紧:隔一天不点页头就变琥珀)。
export const STALE_SYNC_MS = 3 * 24 * 60 * 60 * 1000;

export type AccountSyncStatus = "needsCreds" | "never" | "stale" | "fresh";

// 顺序即优先级:凭据没配齐是根因,「从未同步」是它的后果,分两句说会让人以为有两件事要修。
export function accountSyncStatus(
  account: { needsCredentials: boolean; takenAt: number | null },
  nowMs: number,
): AccountSyncStatus {
  if (account.needsCredentials) return "needsCreds";
  if (account.takenAt == null) return "never";
  return nowMs - account.takenAt > STALE_SYNC_MS ? "stale" : "fresh";
}

export interface SyncAccountInput {
  id: string;
  label: string;
  connectorId: ConnectorId;
  /** 归档时间戳(null = 活跃);归档账户不参与同步、不计入摘要。 */
  archivedAt: number | null;
  /** 凭据是否齐全(与设计的 status==='missing' 对应)。 */
  complete: boolean;
  /** 该账户最新快照时间(null = 从未同步)。 */
  takenAt: number | null;
}

/**
 * 一个来源为什么需要注意。
 *
 * **这一份清单同时装「没有数」和「数旧了」**(#527 裁定 8):以前只有前者,于是一个一周没同步的
 * 账户在摘要里一切正常,首页那个总资产是旧数而屏幕上没有任何迹象。两者的下一步动作不同
 * (一个去补配置、一个点一下同步),但「有件事要看一眼」是同一件事,所以是一份清单、不是两段。
 *
 * 措辞与账户列表那一行逐字相同(`缺少凭据` / `从未同步` / `同步于 X 前`)—— 那套说法本来就在,
 * 面板不必另造一套。
 */
export type SyncAttentionKind = "missing-credentials" | "never-synced" | "stale";

export interface SyncAttentionSource {
  id: string;
  label: string;
  connectorId: ConnectorId;
  kind: SyncAttentionKind;
  /** 最近一次快照时刻;只有 `stale` 用得上(要渲染「同步于 X 前」)。 */
  takenAt: number | null;
}

export interface SyncStatusSummary {
  /** 活跃账户(id + label)——「立即同步」按当前活跃集并发同步。 */
  accounts: { id: string; label: string }[];
  /** 活跃账户总数。 */
  total: number;
  /**
   * **已同步过**且凭据齐全的活跃账户数。
   *
   * 数旧了的**照样算进来** —— 它有数,只是旧;把它从 `N / M` 里减掉等于说「这个来源没同步过」,
   * 那不是事实。它的位置在下面那份清单里。
   */
  ok: number;
  /** 需要看一眼的来源,按严重程度排(缺凭据 → 从未同步 → 数旧了,同档内旧的在前)。 */
  attention: SyncAttentionSource[];
  /** 全部活跃账户里最新的一次快照时间(null = 全部从未同步)。 */
  lastSyncedAt: number | null;
}

// 严重程度序。同档内按 takenAt 升序(越旧越前),没有 takenAt 的算最旧。
const SEVERITY: Record<SyncAttentionKind, number> = {
  "missing-credentials": 0,
  "never-synced": 1,
  stale: 2,
};

const KIND_OF: Record<AccountSyncStatus, SyncAttentionKind | null> = {
  needsCreds: "missing-credentials",
  never: "never-synced",
  stale: "stale",
  fresh: null,
};

// `now` 是显式参数,不在函数里读时钟:这一层要断言「恰好卡在阈值上」这种精确边界,
// 而读墙钟的测试是 flaky 的(CODING.md「别断言墙上时钟」)。handler 从 Effect 的 Clock 取。
export function summarizeSync(accounts: SyncAccountInput[], now: number): SyncStatusSummary {
  const active = accounts.filter((a) => a.archivedAt == null);
  const attention = active
    .flatMap((a) => {
      // 判据与账户列表那一行同一个函数(@/lib/core/sync-freshness),不是同形的第二份。
      const kind =
        KIND_OF[accountSyncStatus({ needsCredentials: !a.complete, takenAt: a.takenAt }, now)];
      return kind
        ? [{ id: a.id, label: a.label, connectorId: a.connectorId, kind, takenAt: a.takenAt }]
        : [];
    })
    .sort((x, y) => SEVERITY[x.kind] - SEVERITY[y.kind] || (x.takenAt ?? 0) - (y.takenAt ?? 0));
  const lastSyncedAt = active.reduce<number | null>(
    (max, a) => (a.takenAt == null ? max : max == null ? a.takenAt : Math.max(max, a.takenAt)),
    null,
  );
  return {
    accounts: active.map((a) => ({ id: a.id, label: a.label })),
    total: active.length,
    ok: active.length - attention.filter((a) => a.kind !== "stale").length,
    attention,
    lastSyncedAt,
  };
}
