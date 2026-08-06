import type { Balance } from "@folio/connectors-basic";
import type { AccountSafe } from "@folio/db";
import { Effect } from "effect";
import { FetchBalancesError, messageOf } from "./errors";
import { platformOf } from "./platform";
import { fetchBalancesWithRetry } from "./retry";
import { Snapshots, SyncLog, type SyncServices, Tokens } from "./services";
import type { AccountSyncResult, OkOutcome, SyncLogger } from "./types";

// 单账户同步:取余额 → 认币 → 重估 → 写快照。
// 错误通道是 never —— 一个账户炸了收成 ok:false,绝不阻断其他账户。

// 安全字段(红线:绝不打 creds/secret/地址)。userId 显式带 —— cron 路径没有请求级上下文。
const fieldsOf = (userId: string, account: AccountSafe) => ({
  userId,
  accountId: account.id,
  connectorId: account.connectorId,
});

// 一步 best-effort:失败记一条 warning 并回落,不中断整条链。
// 认币与重估各用一次 —— 它们是**两个独立的降级点**(一个失败不影响另一个是否执行),
// 共用这个形状只是消除重复,不是把两处降级合并成一处。
const bestEffort = <A>(
  effect: Effect.Effect<A, { readonly message: string }, SyncServices>,
  fallback: A,
  log: SyncLogger,
  fields: Record<string, unknown>,
  message: string,
): Effect.Effect<A, never, SyncServices> =>
  effect.pipe(
    Effect.catchAll((e) =>
      Effect.sync(() => {
        log.warning(message, { ...fields, error: e.message });
        return fallback;
      }),
    ),
  );

// 余额 → 快照行的边界映射。Balance 契约用 value,快照层沿用 usdValue(不动表结构)。
const toSnapshotRows = (
  balances: Balance[],
  connectorId: string,
  idByRef: ReadonlyMap<string, string>,
) =>
  balances.map((b) => ({
    amount: b.amount,
    usdValue: b.value,
    // kind 透传:db 的 SnapshotBalanceInput.kind 与 connectors Balance 同为 4-kind 联合
    //(spot/defi/perp_equity/perp_position;utxo 已并回 spot,ADR 0010)。
    kind: b.kind,
    // 平台(链 ∪ 场馆)在这里算一次、落库(#193):写路径是唯一还认识 tokenRef 的地方,
    // 读端从此只读这一列。规则见 platformOf。
    platform: platformOf(b.tokenRef, connectorId),
    // provider 自带单价(估值原料,Phase 3):重估时捕获,随快照落 self_price。
    selfPrice: b.selfPrice,
    // 认定冻进快照:用的就是重估定价时那一份答案(同一轮只 mint 一次)。symbol / tokenRef
    // 不再落快照 —— 显示名住 Token 那一行,读端按 token_id 取(#243)。
    tokenId: b.tokenRef ? idByRef.get(b.tokenRef) : undefined,
    // meta 仅 defi/perp 有(spot 零 typed meta)→ 用 `in` 收窄后取。
    meta: "meta" in b ? b.meta : undefined,
    // balance 级 note(单个)随各行落 snapshot_balances.note;重估不动它。
    note: b.note,
  }));

// 取余额之后的三步。抽出来是因为「缺凭据」那条路根本不走到这 —— 早退在上面。
const finish = (
  userId: string,
  account: AccountSafe,
  outcome: OkOutcome,
  log: SyncLogger,
  fields: Record<string, unknown>,
) =>
  Effect.gen(function* () {
    const tokens = yield* Tokens;
    const snapshots = yield* Snapshots;
    // 认币先跑,一轮只跑一次,答案同时喂给重估定价和写快照落列(ADR 0021 / #200)。
    const idByRef = yield* bestEffort(
      tokens.mint(userId, outcome.balances),
      new Map<string, string>() as ReadonlyMap<string, string>,
      log,
      fields,
      "mint failed; writing snapshot without token_id",
    );
    // 重估(P7.4.2):manual 用市场价改 usdValue。null = 没重估(未注入或失败)。
    const revalued = yield* bestEffort<Balance[] | null>(
      tokens.revalue(userId, account.connectorId, outcome.balances, idByRef),
      null,
      log,
      fields,
      "revalue failed; keeping provider values",
    );
    const balances = revalued ?? outcome.balances;
    // 只有真重估过才重算 totalUsd;否则保留 provider 报的那个数(它未必等于各行之和)。
    const totalUsd = revalued ? revalued.reduce((sum, b) => sum + b.value, 0) : outcome.totalUsd;
    const snapshotId = yield* snapshots.write(userId, account.id, {
      takenAt: Date.now(),
      totalUsd,
      // account 级 note(Note[],整钱包)落 snapshots.note;重估不动它。
      note: outcome.note,
      balances: toSnapshotRows(balances, account.connectorId, idByRef),
    });
    log.info("account synced", { ...fields, totalUsd, balances: balances.length });
    return { accountId: account.id, ok: true, snapshotId, totalUsd } satisfies AccountSyncResult;
  });

export const syncAccount = (
  userId: string,
  account: AccountSafe,
  rawCreds: string | null, // 由 syncUser 批量预取分发(见 Accounts.rawCreds)
): Effect.Effect<AccountSyncResult, never, SyncServices> =>
  Effect.gen(function* () {
    const log = yield* SyncLog;
    const fields = fieldsOf(userId, account);
    return yield* Effect.gen(function* () {
      // 坏 JSON 也算这个账户的失败。
      const stored = yield* Effect.try({
        try: (): Record<string, string> => (rawCreds ? JSON.parse(rawCreds) : {}),
        catch: (e) => new FetchBalancesError({ message: messageOf(e), retryable: false, cause: e }),
      });
      const outcome = yield* fetchBalancesWithRetry(account, stored, fields);
      // 缺凭据(导入待补录)→ 跳过,不算失败,补录后下次纳入(见 P6.6.1)。
      // **是正常返回值、不进错误通道** —— 它不是出事了,是这轮没事干。
      if (outcome.status === "needs-credentials") {
        log.warning("account sync skipped: needs credentials", fields);
        return { accountId: account.id, ok: false, skipped: true } satisfies AccountSyncResult;
      }
      return yield* finish(userId, account, outcome, log, fields);
    }).pipe(
      // 隔离:失败收成 ok:false,绝不抛。
      Effect.catchAll((err) =>
        Effect.sync((): AccountSyncResult => {
          log.error("account sync failed", {
            ...fields,
            code: err._tag === "FetchBalancesError" ? err.code : undefined,
            error: err.message,
          });
          return { accountId: account.id, ok: false, error: err.message };
        }),
      ),
    );
  });
