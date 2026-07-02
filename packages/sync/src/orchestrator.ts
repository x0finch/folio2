import { type Account, type AccountType, type Balance, ProviderError } from "@folio/balances";
import type { AccountSafe, WriteSnapshotInput } from "@folio/db";

// 取余额结果:缺凭据(导入待补录)→ needs-credentials(跳过、不算失败);否则 ok{balances,totalUsd}。
// 由 app 注入的 fetchBalances 产出(内部先判 isComplete 再解密 + 调 balances.fetchBalances)。
export type FetchOutcome =
  | { status: "ok"; balances: Balance[]; totalUsd: number }
  | { status: "needs-credentials" };

// 退避重试参数(原则 #8:不硬编码散落)。
const RETRY_MAX_ATTEMPTS = 3; // 总尝试次数(1 + 2 重试)
const RETRY_BASE_MS = 200; // 指数退避基数
const RETRY_MAX_MS = 5000; // 单次退避上限(也用于 Retry-After 夹紧)

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
  getRawCreds: (userId: string, accountId: string) => Promise<string | null>;
  writeSnapshot: (userId: string, accountId: string, input: WriteSnapshotInput) => Promise<string>;
  // 取余额(领域意图):app 注入 balances.fetchBalances —— 解密/校验/ctx 拼装/provider 调用全在其内。
  // 缺凭据返回 needs-credentials(跳过,不算失败);上游失败抛 ProviderError(本层据 retryable 重试)。
  fetchBalances: (account: Account, stored: Record<string, string>) => Promise<FetchOutcome>;
  sleep?: (ms: number) => Promise<void>; // 默认 setTimeout;测试注入即时/捕获版做确定性重试测试
  log?: SyncLogger; // 默认 no-op;app 注入 LogTape logger(见 buildSyncDeps)
  // 写快照前重估余额(P7.4.2):app 注入 token 感知实现,仅 manual 用市场价改 usdValue,其余原样
  // (富化不重算)。best-effort:抛错则保留 provider 原值,不让定价故障拖垮同步。@folio/sync 本身不依赖 token 层。
  revalue?: (accountType: AccountType, balances: Balance[]) => Promise<Balance[]>;
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

// 单账户同步,整段 try/catch:失败返回 ok:false,绝不抛(隔离,不阻断其他账户)。
export async function syncAccount(
  deps: SyncDeps,
  userId: string,
  account: AccountSafe,
): Promise<AccountSyncResult> {
  const log = deps.log ?? noopLogger;
  // 安全字段(红线:绝不打 creds/secret/地址);userId 显式带,覆盖 cron 路径(无请求级 withContext)。
  const ctxFields = { userId, accountId: account.id, type: account.type };
  try {
    const raw = await deps.getRawCreds(userId, account.id);
    const stored: Record<string, string> = raw ? JSON.parse(raw) : {};
    const acc: Account = {
      id: account.id,
      userId: account.userId,
      type: account.type,
      network: account.network ?? undefined,
      label: account.label,
    };
    // 取余额(解密/校验/ctx/provider 调用全在 balances.fetchBalances 内)。仅取数部分重试(写快照不重试)。
    const outcome = await withRetry(
      () => deps.fetchBalances(acc, stored),
      deps.sleep ?? defaultSleep,
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
        balances = await deps.revalue(account.type, balances);
        totalUsd = balances.reduce((sum, b) => sum + b.usdValue, 0);
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
      balances,
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

// 同步该用户全部账户,逐账户隔离汇总。
export async function syncUser(deps: SyncDeps, userId: string): Promise<SyncResult> {
  const accounts = await deps.listAccounts(userId);
  const results: AccountSyncResult[] = [];
  for (const account of accounts) {
    results.push(await syncAccount(deps, userId, account));
  }
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
