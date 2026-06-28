import {
  type Account,
  type Balance,
  type FetchContext,
  getProvider,
  isComplete,
  openCreds,
  ProviderError,
  type ProviderRegistry,
  validateCredentials,
} from "@folio/core";
import type { AccountSafe, WriteSnapshotInput } from "@folio/db";
import { appRegistry } from "./registry";

// 退避重试参数(原则 #8:不硬编码散落)。
const RETRY_MAX_ATTEMPTS = 3; // 总尝试次数(1 + 2 重试)
const RETRY_BASE_MS = 200; // 指数退避基数
const RETRY_MAX_MS = 5000; // 单次退避上限(也用于 Retry-After 夹紧)

const defaultSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

// 编排器对数据层【注入式依赖】:db 操作由调用方(server fn)绑好 env 后传入,
// 于是本包不连 D1、可用普通 vitest 测纯逻辑(解密 → 派发 → 隔离 → 汇总)。
// 真实数据访问仍只经 @folio/db(server fn 把其包装函数绑进来)。
export interface SyncDeps {
  listAccounts: (userId: string) => Promise<AccountSafe[]>;
  getRawCreds: (userId: string, accountId: string) => Promise<string | null>;
  writeSnapshot: (userId: string, accountId: string, input: WriteSnapshotInput) => Promise<string>;
  secretsKey: string;
  globalKeys: Record<string, string>;
  registry?: ProviderRegistry; // 默认用 appRegistry;测试可注入假 registry
  sleep?: (ms: number) => Promise<void>; // 默认 setTimeout;测试注入即时/捕获版做确定性重试测试
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

// 纯逻辑:按 account.type 取 provider → 拉余额 → 汇总 totalUsd。无 I/O、无解密。
export async function runAccountSync(
  registry: ProviderRegistry,
  ctx: FetchContext,
): Promise<{ balances: Balance[]; totalUsd: number }> {
  const provider = getProvider(registry, ctx.account.type);
  const balances = await provider.fetchBalances(ctx);
  const totalUsd = balances.reduce((sum, b) => sum + b.usdValue, 0);
  return { balances, totalUsd };
}

// 把整张全局 key 表收窄到 provider 声明用到的子集(env 里存在的才下发)。
// 导出供账户创建时复用(创建即 validate 也要按 usesGlobalKeys 最小权限下发)。
export function scopeGlobalKeys(
  all: Record<string, string>,
  names: readonly string[] = [],
): Record<string, string> {
  const scoped: Record<string, string> = {};
  for (const name of names) {
    if (name in all) scoped[name] = all[name];
  }
  return scoped;
}

// 对可重试的 ProviderError(429/5xx/网络)退避重试;优先采用服务端 Retry-After,否则指数退避+抖动。
// 不可重试错误 / 重试用尽 → 抛出(由 syncAccount 外层收为 ok:false)。
async function withRetry<T>(
  fn: () => Promise<T>,
  sleep: (ms: number) => Promise<void>,
): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      const retryable = err instanceof ProviderError && err.retryable;
      if (!retryable || attempt >= RETRY_MAX_ATTEMPTS) throw err;
      const backoff = Math.min(RETRY_MAX_MS, RETRY_BASE_MS * 2 ** (attempt - 1));
      const base = Math.min(RETRY_MAX_MS, err.retryAfterMs ?? backoff);
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
  const registry = deps.registry ?? appRegistry;
  try {
    const provider = getProvider(registry, account.type);
    const inputs = provider.inputs ?? [];
    const raw = await deps.getRawCreds(userId, account.id);
    const stored: Record<string, string> = raw ? JSON.parse(raw) : {};
    // 缺凭据态(导入待补录:有 semi/secret 字段未填真值)→ 跳过,不算失败,补录后下次纳入(见 P6.6.1)。
    if (!isComplete(inputs, stored)) return { accountId: account.id, ok: false, skipped: true };
    // 只在此刻解密 secret 字段、用完即弃(openCreds:public/semi 明文原样、secret 解密)。
    const opened = await openCreds(inputs, stored, deps.secretsKey);
    // 运行时闸:按 provider.inputs 的 validator 校验,通过才进 FetchContext;脏/缺数据 → 本账户 fail。
    const creds = await validateCredentials(inputs, opened);
    // 非密钥账户数据(manual 持仓)为明文 JSON,直接 parse。
    const data = account.dataJson ? JSON.parse(account.dataJson) : undefined;
    const acc: Account = {
      id: account.id,
      userId: account.userId,
      type: account.type,
      network: account.network ?? undefined,
      label: account.label,
      data,
    };
    // 最小权限:只把本 provider 声明用到的全局 key 下发,拿不到别家的(见 BalanceProvider.usesGlobalKeys)。
    const globalKeys = scopeGlobalKeys(deps.globalKeys, provider.usesGlobalKeys);
    const ctx: FetchContext = { account: acc, creds, globalKeys };
    // 仅 provider 取数部分重试(写快照/解密不重试)。
    const { balances, totalUsd } = await withRetry(
      () => runAccountSync(registry, ctx),
      deps.sleep ?? defaultSleep,
    );
    const snapshotId = await deps.writeSnapshot(userId, account.id, {
      takenAt: Date.now(),
      totalUsd,
      balances,
    });
    return { accountId: account.id, ok: true, snapshotId, totalUsd };
  } catch (err) {
    return {
      accountId: account.id,
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
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
// syncUser 内部已逐账户隔离)。cron 无 UI → 失败用 console.error 记日志(wrangler tail / CF logs 可见)。
export async function syncAllUsers(deps: SyncDeps, userIds: string[]): Promise<SweepResult> {
  let ok = 0;
  let failed = 0;
  let skipped = 0;
  for (const userId of userIds) {
    try {
      const { results } = await syncUser(deps, userId);
      for (const r of results) {
        if (r.ok) ok++;
        else if (r.skipped)
          skipped++; // 缺凭据:不算失败、不记错误日志
        else {
          failed++;
          console.error(`[cron] sync failed: user=${userId} account=${r.accountId} — ${r.error}`);
        }
      }
    } catch (err) {
      // syncUser 理论上不抛(整体兜底),此处仅防御:整个用户失败也不中断 sweep。
      failed++;
      console.error(
        `[cron] sync threw for user=${userId} — ${err instanceof Error ? err.message : err}`,
      );
    }
  }
  return { users: userIds.length, ok, failed, skipped };
}
