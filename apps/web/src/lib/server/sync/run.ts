import { Database, NotFound } from "@folio/db";
import type { AccountSyncResult } from "@folio/sync";
import { Clock, Effect } from "effect";
import { z } from "zod";
import { isManual } from "@/lib/core/manual";
import { ConnectorRegistry } from "@/lib/server/connectors/registry";
import { isComplete, readStoredCreds } from "@/lib/server/creds";
import { startAccountRound } from "./round";
import { isSyncableAccount, type SyncRoundView, syncRoundView } from "./status";

// 只同步单个账户(详情侧栏「同步」、加账户 / 补凭据之后那一次):**排进一轮、投一条消息、即返**(FOL-89)。
//
// 以前这里在请求里把整条链跑完 —— 读账户 → 读凭据 → 同步(出网)→ 预热(价 / 汇率 / 平台 / DeFi 图,
// 又是一圈出网)—— 全部落在这一次调用的 10ms CPU 里。现在同步在队列 consumer 里跑(与 cron 同一个
// 内核,ADR 0055),这里只做**不出网**的那几步:认账户、挡掉注定跳过的、把它排进一轮。
// 前端拿回 `{ queued: true, … }` 后按那一轮轮询,等这个账户落账(`SyncRoundView.statuses`)。
export const SyncAccountInput = z.object({ accountId: z.string().min(1) });

/**
 * `syncAccount` 的回包。
 *
 *   · `queued: false` —— 当场就知道结果、不必排队的那几种(手记 / 凭据没填完 / 已归档),结果就在 `result`。
 *   · `queued: true`  —— 已排进 `portfolioId` 上 `roundId` 那一轮;`round` 是此刻的样子,前端直接落缓存。
 */
export type SyncAccountStart =
  | { queued: false; result: AccountSyncResult }
  | {
      queued: true;
      accountId: string;
      portfolioId: string;
      roundId: string;
      round: SyncRoundView;
    };

// **userId 是显式参数,不是从 context 摸出来的。** 投的消息要带它(consumer 那一侧按它装配),
// 而 `runEffect` 刻意不把 userId 交给 handler。与其为这一处把它重新放进**全部** handler 的可见面,
// 不如这里显式接一次 —— 装配点因此走 `runTimedForUser`(与 `runEffect` 同一个内核,见 ./index)。
export const handleSyncAccount = Effect.fn("syncAccount")(function* (
  userId: string,
  data: z.infer<typeof SyncAccountInput>,
) {
  const accounts = (yield* Database).accounts;
  const account = yield* accounts.getById(data.accountId);
  // 「没这个账户」是**类型化失败**(#504 T6):前端拿到那句人话,兜底日志里有 handler 名和调用链。
  if (!account) return yield* Effect.fail(new NotFound({ entity: "account", id: data.accountId }));
  const done = (result: AccountSyncResult): SyncAccountStart => ({ queued: false, result });
  // manual 不是同步源(ADR 0018:当下值由 creds 现造,不写快照)。UI 已对 manual 隐藏「同步」;此处防御式跳过。
  // **带上为什么跳过**(#527 裁定 2):手记账户没有上游,和「凭据没填完」都跳过,但只有后者有下一步动作。
  if (isManual(account.connectorId)) {
    return done({ accountId: account.id, ok: false, skipped: true, skipReason: "manual" });
  }
  // 归档账户不进任何一轮(开轮的名单判据同一个),排进去也只会被 consumer 记成 skipped。
  if (!isSyncableAccount(account)) return done({ accountId: account.id, ok: false, skipped: true });
  // 凭据没填完:**当场回、不排队**。同步内核照样会判出 needs-keys,但那要一条消息、一次调用才换来
  // 一句此刻就答得出的话;界面也要立刻提示去补凭据(#527 裁定 2)。判据与账户列表的 needsCredentials
  // 同一个(`isComplete` × connector 的字段规格)。
  const specs = (yield* ConnectorRegistry).specs[account.connectorId] ?? [];
  const stored = readStoredCreds(yield* accounts.getRawCreds(account.id)) ?? {};
  if (!isComplete(specs, stored)) {
    return done({
      accountId: account.id,
      ok: false,
      skipped: true,
      skipReason: "missing-credentials",
    });
  }
  const round = yield* startAccountRound(userId, { id: account.id, label: account.label });
  return {
    queued: true,
    accountId: account.id,
    portfolioId: round.portfolioId,
    roundId: round.roundId,
    round: syncRoundView(round, yield* Clock.currentTimeMillis),
  } satisfies SyncAccountStart;
});
