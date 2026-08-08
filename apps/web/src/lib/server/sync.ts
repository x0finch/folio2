import { AccountStore, SnapshotStore } from "@folio/db";
import { syncAccount as syncAccountCore } from "@folio/sync";
import { getLogger } from "@logtape/logtape";
import { createServerFn } from "@tanstack/react-start";
import { Effect } from "effect";
import { z } from "zod";
import { isComplete } from "../creds";
import { isManual } from "../manual-connector";
import { type SyncStatusSummary, summarizeSync } from "../sync-status";
import { credentialSpecs } from "./internal/connector-registry";
import { runRequest } from "./internal/oracle";
import { requireAuth } from "./internal/require-auth";
import { buildSyncDeps, warmTokens } from "./internal/sync-deps";

const syncLog = getLogger(["folio", "web", "sync"]);

// 编排装配在 ./sync-deps(server-only)—— 本文件不引 cloudflare:workers,故这些 server fn 可安全被客户端 import。
// 全量同步走 /api/sync 流式端点(服务端 waitUntil 兜底);这里只留单账户同步(账户抽屉「单独同步」)+ 状态。

// 只同步单个账户(详情侧栏「单独同步」):取该账户 + 其 raw creds → syncAccountCore 隔离写快照。
// 归档账户理论上侧栏会禁用此项;即便调用,syncAccountCore 仍按现有逻辑处理(缺凭据→skipped)。
//
// **一次装配跑完整条链**(#394 T5):读账户 → 读凭据 → 同步 → 预热,四步共一份 context。以前是
// 两次 `db.`(各自建一次 layer、各跑一次 runPromise)+ 一次 `warmTokensForUser`(再建一套),
// 而预热本身内部还要再读一遍账户与快照。
//
// **`syncAccountCore` 仍是 Promise**,所以中间必然有一道 `tryPromise` —— `@folio/sync` 的公开出口
// 是 Promise 形状(它内部是 Effect,`index.ts` 那层壳把依赖接上再 `runPromise`)。把它的 Effect
// 内核直接接出来是可行的,但 `SyncDeps` 的每个方法都收 userId(cron 用一份 deps 扫全部用户),
// 与 db 现在 per-user 装配的形状对不上 —— 那是它自己的一票,不在这里顺手做(见 PR 说明)。
export const syncAccount = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .validator(z.object({ accountId: z.string().min(1) }))
  .handler(async ({ data, context }) => {
    const userId = context.userId;
    // 「没这个账户」在**边缘**抛,不在 effect 里 `die` —— 后者会被 `runPromise` 包成 FiberFailure,
    // 上层日志里就只剩一坨 Cause、没有这句话了(oracle.ts 的 `toError` 同一个理由)。
    const result = await runRequest(
      userId,
      Effect.gen(function* () {
        const accounts = yield* AccountStore;
        const account = yield* accounts.getById(data.accountId);
        if (!account) return null;
        // manual 不是同步源(ADR 0018:当下值由 creds 现造,不写快照)。UI 已对 manual 隐藏「同步」;此处防御式跳过。
        if (isManual(account.connectorId)) {
          return { accountId: account.id, ok: false, skipped: true };
        }
        const rawCreds = yield* accounts.getRawCreds(data.accountId);
        const result = yield* Effect.promise(() =>
          syncAccountCore(buildSyncDeps(), userId, account, rawCreds),
        );
        syncLog.info("single account sync", {
          accountId: account.id,
          connectorId: account.connectorId,
          ok: result.ok,
          skipped: result.skipped,
        });
        yield* warmTokens; // 让总览能 cache-only 富化新价
        return result;
      }),
    );
    if (!result) throw new Error("account not found");
    return result;
  });

// 全局同步状态摘要(PageHeader 共享同步面板;每个认证页 loader 消费)。
// 轻量:仅 3 次 D1 读(accounts / raw creds / 最新快照),不做富化/估值。
// 缺凭据判定复用 creds.isComplete + connectors.credentialSpecs(与 listAccounts 同源);派生走纯模块 summarizeSync。
export const getSyncStatus = createServerFn({ method: "GET" })
  .middleware([requireAuth])
  .handler(
    async ({ context }): Promise<SyncStatusSummary> =>
      runRequest(
        context.userId,
        Effect.gen(function* () {
          const [accountStore, snapshotStore] = [yield* AccountStore, yield* SnapshotStore];
          // 三次读互不依赖 → 并发取(以前是 `Promise.all` 上三个各自装配一次的门面调用)。
          const [accounts, rawList, snapshots] = yield* Effect.all(
            [accountStore.list(), accountStore.listRawCreds(), snapshotStore.latest()],
            { concurrency: 3 },
          );
          const rawById = new Map(rawList.map((r) => [r.id, r.creds]));
          const takenAtById = new Map(
            snapshots.map((s) => [s.snapshot.accountId, s.snapshot.takenAt]),
          );
          const specsByType = credentialSpecs();
          // manual 不是同步源(ADR 0018)→ 不列入同步面板/「立即同步」集,也不显示为「未同步」。
          const syncable = accounts.filter((a) => !isManual(a.connectorId));
          return summarizeSync(
            syncable.map((a) => {
              const raw = rawById.get(a.id);
              const stored: Record<string, string> = raw ? JSON.parse(raw) : {};
              const specs = specsByType[a.connectorId] ?? [];
              return {
                id: a.id,
                label: a.label,
                archivedAt: a.archivedAt,
                complete: isComplete(specs, stored),
                takenAt: takenAtById.get(a.id) ?? null,
              };
            }),
          );
        }),
      ),
  );
