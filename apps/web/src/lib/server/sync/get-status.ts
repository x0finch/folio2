import { Database } from "@folio/db";
import { Clock, Effect } from "effect";
import { z } from "zod";
import { accountIdsInView } from "@/lib/core/accounts-in-view";
import { ConnectorRegistry } from "@/lib/server/connectors/registry";
import { isComplete, readStoredCreds } from "@/lib/server/creds";
import { summarizeSync } from "./status";

// 全局同步状态摘要(PageHeader 共享同步面板;每个认证页 loader 消费)。
// 轻量:仅 3 次 D1 读(accounts / raw creds / 最新快照),不做富化/估值。
// 缺凭据判定复用 creds.isComplete + connectors.credentialSpecs(与 listAccounts 同源);
// 派生走纯模块 ./status 的 summarizeSync(无 cloudflare env,可脱离 server fn 单测)。
//
// **ok 数的是「真的同步过」,不是「配置齐全」。** 这两者曾被当成一回事:`ok` 只看
// `complete`,`takenAt` 收进来却只喂给 `lastSyncedAt`。于是一个刚加进来、凭据齐全、
// 一次都没拉过数据的账户被算进 ok,面板显示「All synced 2 / 2」,而账户行上明明写着
// 「Never synced」——「我们还没去问」和「问过了,是这个数」在摘要里长得一样。
// 面板的字面是 "Sources synced",所以口径必须是同步过。
export const GetSyncStatusInput = z.object({ portfolioId: z.string().min(1) });

export const handleGetSyncStatus = Effect.fn("getSyncStatus")(function* (
  data: z.infer<typeof GetSyncStatusInput>,
) {
  const {
    accounts: accountStore,
    snapshots: snapshotStore,
    portfolios: portfolioStore,
  } = yield* Database;
  const specsByType = (yield* ConnectorRegistry).specs;
  // 五次读互不依赖 → 并发取。
  const [accounts, rawList, snapshots, memberships, defaultPortfolio] = yield* Effect.all(
    [
      accountStore.list(),
      accountStore.listRawCreds(),
      snapshotStore.latest(),
      portfolioStore.listMemberships(),
      portfolioStore.ensureDefault(),
    ],
    { concurrency: 5 },
  );
  const rawById = new Map(rawList.map((r) => [r.id, r.creds]));
  const takenAtById = new Map(snapshots.map((s) => [s.snapshot.accountId, s.snapshot.takenAt]));
  // **按选中的 Portfolio 收口**(ADR 0033):页头那块摘要以前读的是该用户**全部**账户,于是切
  // Portfolio 它一动不动 —— 账户页只剩一个账户,而它旁边仍写着 `8 / 8`,清单里列的还是别处的账户。
  // 判据与账户页那份过滤同一个函数,不是同形的第二份。
  const inView = accountIdsInView(
    accounts.map((a) => a.id),
    memberships,
    data.portfolioId,
    defaultPortfolio.id,
  );
  // **manual 也传下去**:它不是同步源(ADR 0018),但它是一个「来源」—— 分道在 summarizeSync 里,
  // 因为那两个数(能同步的 / 一共几个来源)都由它算。这里只管视图过滤。
  const inThisView = accounts.filter((a) => inView.has(a.id));
  // 「多久没同步算旧」要一个当下(#527 裁定 8)。走 Clock 而不是 `Date.now()`:纯派生那层
  // 收的是显式 `now`,这里就是它的唯一来源。
  const now = yield* Clock.currentTimeMillis;
  return summarizeSync(
    inThisView.map((a) => {
      // 解不开的凭据 → 当没填(#527 裁定 1):面板上显示「缺少凭据」,而不是整个总览 500。
      const stored = readStoredCreds(rawById.get(a.id)) ?? {};
      const specs = specsByType[a.connectorId] ?? [];
      return {
        id: a.id,
        label: a.label,
        connectorId: a.connectorId,
        archivedAt: a.archivedAt,
        complete: isComplete(specs, stored),
        takenAt: takenAtById.get(a.id) ?? null,
      };
    }),
    now,
  );
});
