import { AccountStore } from "@folio/db";
import { Account as SyncKernel } from "@folio/sync";
import { getLogger } from "@logtape/logtape";
import { Effect } from "effect";
import { z } from "zod";
import { isManual } from "../../core/manual";
import { logCategory } from "../effect-log";
import { runRequest } from "../oracle";
import { syncServicesLayer, warmTokens } from "./deps";

const syncLog = getLogger(["folio", "web", "sync"]);

// 只同步单个账户(详情侧栏「单独同步」):取该账户 + 其 raw creds → `@folio/sync` 内核隔离写快照。
// 归档账户理论上侧栏会禁用此项;即便调用,内核仍按现有逻辑处理(缺凭据→skipped)。
// 全量同步走 /api/sync 流式端点(服务端 waitUntil 兜底);这里只管单账户同步(状态在 ./get-status)。
//
// **一次装配跑完整条链**(#394 T5):读账户 → 读凭据 → 同步 → 预热,四步共一份 context。以前是
// 两次 `db.`(各自建一次 layer、各跑一次 runPromise)+ 一次 `warmTokensForUser`(再建一套),
// 而预热本身内部还要再读一遍账户与快照。
//
// **同步内核也在这一个 effect 里**(#403 片 2):`@folio/sync` 的 Effect 内核直接接出来,
// `SyncServices` 由 `syncServicesLayer` 供上,而它要的 db / 参考层服务就是外面这次
// `runRequest(userId, …)` 已经装好的那些。以前这里是 `Effect.promise(() => syncAccountCore(…))`——
// 一道 Promise 边界,而且内核里的 mint / revalue 各自还要再装一次参考层。
export const SyncAccountInput = z.object({ accountId: z.string().min(1) });

export async function handleSyncAccount({
  data,
  context,
}: {
  data: z.infer<typeof SyncAccountInput>;
  context: { userId: string };
}) {
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
      // `logCategory("sync")`:内核的日志落 `folio.sync`,不跟着请求这一半走 `folio.oracle`。
      // **不能靠再叠一层 `Logger.replace`** —— 那不会顶掉外层那个,只会两个都在、每条写两遍
      // (#403 片 2 实测)。类目跟着日志走,转发器只有一个。
      const result = yield* SyncKernel.syncAccount(userId, account, rawCreds).pipe(
        Effect.provide(syncServicesLayer),
        logCategory("sync"),
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
}
