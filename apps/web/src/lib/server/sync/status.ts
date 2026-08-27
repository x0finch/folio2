import type { ConnectorId } from "@folio/connectors";
import type {
  AccountSafe,
  SyncRoundAccountStatus,
  SyncRoundRecord,
  SyncRoundTrigger,
} from "@folio/db";
import { isManual } from "@/lib/core/manual";

// 可同步账户判别:活跃(未归档)且**不是 manual** —— manual 不是同步源:当下值实时由 creds.tokens
// 现造、不写快照(ADR 0018)。住这儿(而不是单开一个文件):这个模块就是「谁算同步过 / 谁可同步」
// 的派生层,`summarizeSync` 里那条 `!isManual` 的分道与它是同一个概念的两面。
export function isSyncableAccount(a: Pick<AccountSafe, "archivedAt" | "connectorId">): boolean {
  return a.archivedAt == null && !isManual(a.connectorId);
}

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

/** 一轮的下场三选一。**中断不是一种失败** —— 它是「没人再往下跑了」,连结果都没有。 */
export type SyncRoundState = "running" | "interrupted" | "done";

export interface SyncRoundFailure {
  accountId: string;
  /** 开轮那一刻冻下来的展示名(服务端只按 id 记结果)。 */
  label: string;
  error: string;
}

/** 面板读到的那一份。轮询只拉这个 —— 它是这条链路上唯一在变的东西。 */
export interface SyncRoundView {
  roundId: string;
  state: SyncRoundState;
  trigger: SyncRoundTrigger;
  startedAt: number;
  finishedAt: number | null;
  /** 这一轮的条数 —— 进行中那句 `x / N` 的 N。 */
  total: number;
  /** 已经有结果的条数 —— 那句 `x / N` 的 x。 */
  settled: number;
  /**
   * 三段式的第一段(ADR 0048 裁定 7)。**只数这一轮真同步成功的** ——
   * 面板显示时再加上手记那些不参与同步的来源,两笔各自诚实,不在这一层混。
   */
  synced: number;
  /** 第二段。逐条列出来,面板要点得进去。 */
  failed: SyncRoundFailure[];
  /** 第三段:凭据还没填完的。既不算成功也不算失败。 */
  needsKeys: number;
  /** 还没轮到的第一个账户 —— 进行中那句「正在同步谁」。 */
  current: string | null;
  /** 整轮没跑起来那一句(取账户 / 取凭据挂了)。逐账户的失败不在这里。 */
  error: string | null;
}

// 失败但上游一句话都没留下时的兜底。面板那一行右边是空的话,读的人只会以为界面坏了。
const UNKNOWN_FAILURE = "sync failed";

/**
 * 把库里那份轮记录念成面板要的形状。
 *
 * **活轮判据一句话:未收官且未过期。**过期用 `<=` —— `expiresAt` 是「活到这一刻为止」,
 * 与开轮那条覆盖条件同一个口径,两处必须一致,否则会出现「开得了新轮但面板还说旧轮在跑」。
 *
 * `now` 是显式参数(与 `summarizeSync` 同款理由):这一层要断言精确边界,读墙钟的测试是 flaky 的。
 */
export function syncRoundView(round: SyncRoundRecord, now: number): SyncRoundView {
  const entries = Object.entries(round.accounts);
  const tally: Record<SyncRoundAccountStatus, number> = {
    pending: 0,
    synced: 0,
    failed: 0,
    "needs-keys": 0,
  };
  const failed: SyncRoundFailure[] = [];
  let current: string | null = null;
  for (const [accountId, a] of entries) {
    tally[a.status] += 1;
    if (a.status === "pending") current ??= a.label;
    if (a.status === "failed") {
      failed.push({ accountId, label: a.label, error: a.error || UNKNOWN_FAILURE });
    }
  }
  const state: SyncRoundState =
    round.finishedAt != null ? "done" : now >= round.expiresAt ? "interrupted" : "running";
  return {
    roundId: round.roundId,
    state,
    trigger: round.trigger,
    startedAt: round.startedAt,
    finishedAt: round.finishedAt,
    total: entries.length,
    settled: entries.length - tally.pending,
    synced: tally.synced,
    failed,
    needsKeys: tally["needs-keys"],
    current,
    error: round.error ?? null,
  };
}
