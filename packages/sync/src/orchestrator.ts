import { type Balance, ProviderError } from "@folio/connectors-basic";
import type { AccountRawCreds, AccountSafe, WriteSnapshotInput } from "@folio/db";

// 取余额结果:缺凭据(导入待补录)→ needs-credentials(跳过、不算失败);否则 ok{balances,totalUsd}。
// 由 app 注入的 fetchBalances 产出(内部先判 isComplete 再解密 + 调 balances.fetchBalances)。
export type FetchOutcome =
  | { status: "ok"; balances: Balance[]; totalUsd: number }
  | { status: "needs-credentials" };

// 退避重试参数(原则 #8:不硬编码散落)。
const RETRY_MAX_ATTEMPTS = 3; // 总尝试次数(1 + 2 重试)
const RETRY_BASE_MS = 200; // 指数退避基数
const RETRY_MAX_MS = 5000; // 单次退避上限(也用于 Retry-After 夹紧)
const SYNC_CONCURRENCY = 6; // 每用户账户取数的并发上限(CF subrequest / provider 限流留余量)
const FETCH_TIMEOUT_MS = 20_000; // 单次取数(单次尝试)超时上限

const defaultSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

// 注入式 logger(最小接口,结构兼容 LogTape 的 Logger)。app 注入 getLogger(["folio","sync"]);
// 测试注入 no-op/捕获式 → 不耦合 LogTape、不污染输出。userId 由 syncAccount 显式带字段(cron 路径无请求上下文)。
export interface SyncLogger {
  debug(message: string, properties?: Record<string, unknown>): void;
  info(message: string, properties?: Record<string, unknown>): void;
  warning(message: string, properties?: Record<string, unknown>): void;
  error(message: string, properties?: Record<string, unknown>): void;
}
const noopLogger: SyncLogger = {
  debug() {},
  info() {},
  warning() {},
  error() {},
};

// 编排器对数据层【注入式依赖】:db 操作由调用方(server fn)绑好 env 后传入,
// 于是本包不连 D1、可用普通 vitest 测纯逻辑(解密 → 派发 → 隔离 → 汇总)。
// 真实数据访问仍只经 @folio/db(server fn 把其包装函数绑进来)。
export interface SyncDeps {
  listAccounts: (userId: string) => Promise<AccountSafe[]>;
  // 批量取该用户全部账户的 raw creds(一次查,syncUser 分发给各 syncAccount)—— 消除按账户的 N+1。
  listRawCreds: (userId: string) => Promise<AccountRawCreds[]>;
  writeSnapshot: (userId: string, accountId: string, input: WriteSnapshotInput) => Promise<string>;
  // 取余额(领域意图):app 注入 balances.fetchBalances —— 解密/校验/ctx 拼装/provider 调用全在其内。
  // 缺凭据返回 needs-credentials(跳过,不算失败);上游失败抛 ProviderError(本层据 retryable 重试)。
  fetchBalances: (account: AccountSafe, stored: Record<string, string>) => Promise<FetchOutcome>;
  sleep?: (ms: number) => Promise<void>; // 默认 setTimeout;测试注入即时/捕获版做确定性重试测试
  log?: SyncLogger; // 默认 no-op;app 注入 LogTape logger(见 buildSyncDeps)
  // 写快照前重估余额(P7.4.2):app 注入 token 感知实现,仅 manual 用市场价改 usdValue,其余原样
  // (富化不重算)。best-effort:抛错则保留 provider 原值,不让定价故障拖垮同步。@folio/sync 本身不依赖 token 层。
  revalue?: (accountType: string, balances: Balance[]) => Promise<Balance[]>;
}

export interface AccountSyncResult {
  accountId: string;
  ok: boolean;
  skipped?: boolean; // 缺凭据态(导入待补录):跳过、不算失败(见 P6.6)
  snapshotId?: string;
  totalUsd?: number;
  error?: string;
}

export interface SyncResult {
  results: AccountSyncResult[];
}

// 对可重试的 ProviderError(429/5xx/网络)退避重试;优先采用服务端 Retry-After,否则指数退避+抖动。
// 不可重试错误 / 重试用尽 → 抛出(由 syncAccount 外层收为 ok:false)。logCtx = {accountId,type} 入每条重试日志。
async function withRetry<T>(
  fn: () => Promise<T>,
  sleep: (ms: number) => Promise<void>,
  log: SyncLogger,
  logCtx: Record<string, unknown>,
): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      const retryable = err instanceof ProviderError && err.retryable;
      if (!retryable || attempt >= RETRY_MAX_ATTEMPTS) throw err;
      const backoff = Math.min(RETRY_MAX_MS, RETRY_BASE_MS * 2 ** (attempt - 1));
      const base = Math.min(RETRY_MAX_MS, err.retryAfterMs ?? backoff);
      log.warning("provider call retrying", {
        ...logCtx,
        attempt,
        code: err instanceof ProviderError ? err.code : undefined,
        retryAfterMs: err instanceof ProviderError ? err.retryAfterMs : undefined,
      });
      await sleep(base + Math.random() * RETRY_BASE_MS); // 抖动,避免同步雪崩
    }
  }
}

// 有界并发:N 个在飞、逐个补位,结果按输入序返回。fn 不抛(syncAccount 已吞错)→ 无需处理 reject。
async function runPool<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      results[i] = await fn(items[i], i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

// 单次取数超时:超时抛 retryable ProviderError(→ withRetry 重试)。用真 setTimeout 计时(独立于退避 sleep,
// 故注入即时 sleep 的测试不受影响);p 先决出即 clearTimeout,既避免悬空 rejection 又不留 dangling 定时器。
// 注:仅"停止等待",不真正 abort 底层 fetch(CF 上 dangling fetch 随 isolate 回收)。
function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () =>
        reject(
          new ProviderError("UPSTREAM_ERROR", "provider fetch timed out", { retryable: true }),
        ),
      ms,
    );
  });
  return Promise.race([p, timeout]).finally(() => clearTimeout(timer));
}

// 单账户同步,整段 try/catch:失败返回 ok:false,绝不抛(隔离,不阻断其他账户)。
export async function syncAccount(
  deps: SyncDeps,
  userId: string,
  account: AccountSafe,
  rawCreds: string | null, // 由 syncUser 批量预取分发(见 listRawCreds)
): Promise<AccountSyncResult> {
  const log = deps.log ?? noopLogger;
  const sleep = deps.sleep ?? defaultSleep;
  // 安全字段(红线:绝不打 creds/secret/地址);userId 显式带,覆盖 cron 路径(无请求级 withContext)。
  const ctxFields = { userId, accountId: account.id, connectorId: account.connectorId };
  try {
    const stored: Record<string, string> = rawCreds ? JSON.parse(rawCreds) : {};
    // 取余额(解密/校验/ctx/provider 调用全在注入的 fetchBalances 内)。仅取数部分重试(写快照不重试);
    // 每次尝试加超时(挂住的 provider → 超时 → 按 retryable 重试),避免内联 triggerSync 被拖住。
    const outcome = await withRetry(
      () => withTimeout(deps.fetchBalances(account, stored), FETCH_TIMEOUT_MS),
      sleep,
      log,
      ctxFields,
    );
    // 缺凭据态(导入待补录)→ 跳过,不算失败,补录后下次纳入(见 P6.6.1)。
    if (outcome.status === "needs-credentials") {
      log.warning("account sync skipped: needs credentials", ctxFields);
      return { accountId: account.id, ok: false, skipped: true };
    }
    // 重估(P7.4.2):manual 用市场价改 usdValue,再重算 totalUsd。best-effort —— 失败保留 provider 原值。
    let { balances, totalUsd } = outcome;
    if (deps.revalue) {
      try {
        balances = await deps.revalue(account.connectorId, balances);
        totalUsd = balances.reduce((sum, b) => sum + b.value, 0);
      } catch (e) {
        log.warning("revalue failed; keeping provider values", {
          ...ctxFields,
          error: e instanceof Error ? e.message : String(e),
        });
      }
    }
    const snapshotId = await deps.writeSnapshot(userId, account.id, {
      takenAt: Date.now(),
      totalUsd,
      // 边界映射:Balance 契约用 value,快照层沿用 usdValue(不动表结构)。其余字段透传;
      // token 元信息(name/logo/tokenKey)不落快照,参考层是其 home(见 canonical 计划)。
      // kind 透传:db 的 SnapshotBalanceInput.kind 与 connectors Balance 同为 5-kind 联合
      //(spot/defi/perp_equity/perp_position/utxo,#37c 起 db 直取 @folio/connectors-basic),直接透传。
      balances: balances.map((b) => ({
        symbol: b.symbol,
        amount: b.amount,
        usdValue: b.value,
        kind: b.kind,
        tokenKey: b.tokenKey,
        meta: b.meta,
      })),
    });
    log.info("account synced", { ...ctxFields, totalUsd, balances: balances.length });
    return { accountId: account.id, ok: true, snapshotId, totalUsd };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    log.error("account sync failed", {
      ...ctxFields,
      code: err instanceof ProviderError ? err.code : undefined,
      error,
    });
    return { accountId: account.id, ok: false, error };
  }
}

// 同步该用户全部账户,逐账户隔离、有界并发汇总。account/creds 各一次批量读(消 N+1),再分发。
export async function syncUser(deps: SyncDeps, userId: string): Promise<SyncResult> {
  const [accounts, rawList] = await Promise.all([
    deps.listAccounts(userId),
    deps.listRawCreds(userId),
  ]);
  const credsById = new Map(rawList.map((r) => [r.id, r.creds]));
  const results = await runPool(accounts, SYNC_CONCURRENCY, (account) =>
    syncAccount(deps, userId, account, credsById.get(account.id) ?? null),
  );
  return { results };
}

export interface SweepResult {
  users: number;
  ok: number; // 成功账户数
  failed: number; // 失败账户数
  skipped: number; // 缺凭据跳过数(待补录,见 P6.6)
}

// 定时同步全量 sweep(P6.3):逐用户调 syncUser,逐用户 try/catch 隔离(一个用户炸不影响其余;
// syncUser 内部已逐账户隔离)。失败经注入 logger 记构化日志(每账户失败已在 syncAccount 记,这里只兜底用户级抛错)。
export async function syncAllUsers(deps: SyncDeps, userIds: string[]): Promise<SweepResult> {
  const log = deps.log ?? noopLogger;
  let ok = 0;
  let failed = 0;
  let skipped = 0;
  for (const userId of userIds) {
    try {
      const { results } = await syncUser(deps, userId);
      for (const r of results) {
        if (r.ok) ok++;
        else if (r.skipped)
          skipped++; // 缺凭据:不算失败
        else failed++; // 具体错误已在 syncAccount 以 error 级记录
      }
    } catch (err) {
      // syncUser 理论上不抛(整体兜底),此处仅防御:整个用户失败也不中断 sweep。
      failed++;
      log.error("user sweep threw", {
        userId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return { users: userIds.length, ok, failed, skipped };
}
