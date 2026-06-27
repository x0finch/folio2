import {
  type Account,
  type Balance,
  decrypt,
  type FetchContext,
  getProvider,
  type ProviderRegistry,
} from "@folio/core";
import type { AccountSafe, WriteSnapshotInput } from "@folio/db";
import { appRegistry } from "./registry";

// 编排器对数据层【注入式依赖】:db 操作由调用方(server fn)绑好 env 后传入,
// 于是本包不连 D1、可用普通 vitest 测纯逻辑(解密 → 派发 → 隔离 → 汇总)。
// 真实数据访问仍只经 @folio/db(server fn 把其包装函数绑进来)。
export interface SyncDeps {
  listAccounts: (userId: string) => Promise<AccountSafe[]>;
  getEncryptedCredentials: (userId: string, accountId: string) => Promise<string | null>;
  writeSnapshot: (userId: string, accountId: string, input: WriteSnapshotInput) => Promise<string>;
  secretsKey: string;
  globalKeys: Record<string, string>;
  registry?: ProviderRegistry; // 默认用 appRegistry;测试可注入假 registry
}

export interface AccountSyncResult {
  accountId: string;
  ok: boolean;
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

// 单账户同步,整段 try/catch:失败返回 ok:false,绝不抛(隔离,不阻断其他账户)。
export async function syncAccount(
  deps: SyncDeps,
  userId: string,
  account: AccountSafe,
): Promise<AccountSyncResult> {
  const registry = deps.registry ?? appRegistry;
  try {
    const provider = getProvider(registry, account.type);
    const encCreds = await deps.getEncryptedCredentials(userId, account.id);
    // 密钥只在此刻解密,用完即弃。manual 账户密文是加密的 {}(无密钥)。
    const creds = encCreds ? JSON.parse(await decrypt(encCreds, deps.secretsKey)) : {};
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
    const { balances, totalUsd } = await runAccountSync(registry, ctx);
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
