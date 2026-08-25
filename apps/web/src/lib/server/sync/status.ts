import type { ConnectorId } from "@folio/connectors";
import { isManual } from "@/lib/core/manual";

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
type SyncAttentionKind = "missing-credentials" | "never-synced" | "stale";

export interface SyncAttentionSource {
  id: string;
  label: string;
  connectorId: ConnectorId;
  kind: SyncAttentionKind;
  /** 最近一次快照时刻;只有 `stale` 用得上(要渲染「同步于 X 前」)。 */
  takenAt: number | null;
}

export interface SyncStatusSummary {
  /**
   * **可同步的**活跃账户(id + label)——「立即同步」按这一集并发同步。
   *
   * 手记账户不在里面:它没有上游可问(ADR 0018 —— 当下值读的时候现算,从不写快照)。
   */
  accounts: { id: string; label: string }[];
  /**
   * 这个视图里的活跃账户数 —— 面板里 `N / M` 的那个 M,**含手记账户**。
   *
   * **分母就是「一共几个来源」**,与页头那句「across N sources」逐字同一个数。以前它只数可同步的
   * 那些,于是同一个界面上两个都叫 source 的数字对不上:副标题说 10 个来源,面板说 8 个。
   */
  total: number;
  /**
   * **有数**的来源数 —— `N / M` 的那个 N。
   *
   * 「有数」= 同步过的,**加上手记账户**:后者的值是读的时候现算的,永远是当下,所以它一直算有数。
   * 不这么算的话它就永远躺在分母里、永远进不了分子,看起来像两个永久欠同步的来源。
   *
   * 数旧了的**照样算进来** —— 它有数,只是旧;把它减掉等于说「这个来源没同步过」,那不是事实。
   * 它的位置在下面那份清单里。
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
  // 手记账户在这里分道:它算一个「来源」(进分母、也进分子),但不是一个可同步的东西 ——
  // 「立即同步」不该去问它,清单里也不该出现它。
  const syncable = active.filter((a) => !isManual(a.connectorId));
  const attention = syncable
    .flatMap((a) => {
      // 判据与账户列表那一行同一个函数(@/lib/core/sync-freshness),不是同形的第二份。
      const kind =
        KIND_OF[accountSyncStatus({ needsCredentials: !a.complete, takenAt: a.takenAt }, now)];
      return kind
        ? [{ id: a.id, label: a.label, connectorId: a.connectorId, kind, takenAt: a.takenAt }]
        : [];
    })
    .sort((x, y) => SEVERITY[x.kind] - SEVERITY[y.kind] || (x.takenAt ?? 0) - (y.takenAt ?? 0));
  const lastSyncedAt = syncable.reduce<number | null>(
    (max, a) => (a.takenAt == null ? max : max == null ? a.takenAt : Math.max(max, a.takenAt)),
    null,
  );
  return {
    accounts: syncable.map((a) => ({ id: a.id, label: a.label })),
    total: active.length,
    // 减掉的只有「没有数」那两档(缺凭据 / 从未同步);数旧了的仍然有数,手记账户一直有数。
    ok: active.length - attention.filter((a) => a.kind !== "stale").length,
    attention,
    lastSyncedAt,
  };
}
