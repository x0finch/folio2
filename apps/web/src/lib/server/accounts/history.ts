import { Database } from "@folio/db";
import { Effect } from "effect";
import { z } from "zod";
import type { AccountHistoryRaw } from "@/lib/core/history";
import { MANUAL_CONNECTOR_ID } from "@/lib/core/manual";
import { loadManualAccountLiveTotal, loadManualAccountSeries } from "@/lib/server/manual/store";

// 单账户价值历史(抽屉头部那条小曲线):**只发原料点,不算曲线**(FOL-38 / ADR 0049)。
// 阶梯重建与降采样在浏览器里(`buildAccountValueHistory`)。
//
// **窗口(`since`)留在服务端,而且必须留。** 它是一句 WHERE,不是计算,但它是这条接口的**上界** ——
// 以前服务端降采样过再发,不管账户同步了多久,出门的顶多四十个点;现在发的是原样的点,没有窗口
// 就等于「一个账户攒多久的历史,就发多大的响应」。按生产实测的密度(每账户每天 2–11 行)一年就是
// 几千行、上百 KB。所以:抽屉切窗口照旧回服务器一趟,换来的是响应大小由窗口定死。
//
// 两条读路径:非 manual 走快照;manual 不写快照(ADR 0018)→ 走账本 compute-on-read 的日网格
// (ADR 0019),过去点由账本折叠 + oracle 历史价,**再带一个「当下」实时盯市点**(`live`),
// 与抽屉头 `account.totalUsd` 同源。
//
// **归档账户的「当下」是封存那一刻**(ADR 0039)。manual 那条路本来会一路算到今天,而抽屉头显示的
// 是封存值 —— 不截断的话一个抽屉里两个说法(数字停着、曲线还在长)。归档时:
//   · 网格末点 τ = archivedAt,不是 `Date.now()`
//   · 不给 `live` —— 那正是「还在动」的那一笔
// 非 manual 不需要特殊处理:归档之后不再产生新快照,曲线天然停在最后一次同步。
//
// 归档态**在这里自己读**,不收调用方传的:它决定「画到哪儿为止」,不该由客户端说了算。
//
// 从 `getAccountHistory` 里抽出来的,不是新逻辑 —— 抽的理由与 `account-holdings.ts` 一样:
// server fn 那层拿不到测试上下文,而这条分支的行为(末点停在哪)只有驱动真链路才验得到。
export const loadAccountHistory = (input: {
  accountId: string;
  since?: number;
  connectorId?: string;
}) =>
  Effect.gen(function* () {
    const db = yield* Database;
    if (input.connectorId !== MANUAL_CONNECTOR_ID) {
      // 两列 + 一句 WHERE。走 `listTotalsByAccount` 而不是 `listByAccount`:后者是 `select()` 全列
      // (含 note / meta_json 那些整块 JSON),曲线一个都用不上,而这份是要出门的。
      const rows = yield* db.snapshots.listTotalsByAccount(input.accountId, input.since);
      return { rows, live: null } satisfies AccountHistoryRaw;
    }
    const account = yield* db.accounts.getById(input.accountId);
    const archivedAt = account?.archivedAt ?? null;
    const now = archivedAt ?? Date.now();
    // **账本序列与实时末点一次装配**:两者本来就要对齐同一个 now,分两次跑还各建一套 store。
    const rows = yield* loadManualAccountSeries(input.accountId, now);
    const liveTotal =
      archivedAt != null ? null : yield* loadManualAccountLiveTotal(input.accountId);
    return {
      // 日网格必须整条现算(要从首笔活动折下来),但**出门的只有窗口内那一段**。
      rows: rows
        .filter((r) => input.since == null || r.takenAt >= input.since)
        .map((r) => ({ takenAt: r.takenAt, totalUsd: r.totalUsd })),
      // 末点接实时盯市(与抽屉头同源)。空账户不凭空造点 —— 那条判断在前端那个装配函数里,
      // 与「有几个点才画得出线」住在一起。
      live: liveTotal == null ? null : { t: now, total: liveTotal },
    } satisfies AccountHistoryRaw;
  });

// getAccountHistory 的 handler:auth 薄壳,读路径分流全在上面的 loadAccountHistory。
export const AccountHistoryInput = z.object({
  accountId: z.string().min(1),
  since: z.number().int().nonnegative().optional(),
  connectorId: z.string().optional(),
});

export const handleGetAccountHistory = Effect.fn("getAccountHistory")(function* (
  data: z.infer<typeof AccountHistoryInput>,
) {
  return yield* loadAccountHistory(data);
});
