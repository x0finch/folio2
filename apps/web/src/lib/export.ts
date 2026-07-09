// 纯逻辑(无 server-only import → 可单测)。把各实体映射成导出 NDJSON 记录(逐行一个 JSON)。
// 红线:account 的 safeCreds 由 lib/creds.ts safeView 在 route 算好后传入(secret 丢、semi 打码、public 留)。

export const EXPORT_VERSION = 1;

interface AccountIn {
  id: string;
  type: string;
  network: string | null;
  label: string;
}
interface GroupIn {
  id: string;
  name: string;
  sortOrder: number;
}
interface SnapshotIn {
  accountId: string;
  takenAt: number;
  totalUsd: number;
}
interface BalanceIn {
  symbol: string;
  amount: number;
  usdValue: number;
  kind: string;
  metaJson: string | null;
}

function safeParse(json: string | null): unknown {
  if (!json) return undefined;
  try {
    return JSON.parse(json);
  } catch {
    return undefined;
  }
}

// 首行:版本号等关键信息,供 P6.6 导入做兼容/迁移判断。
export function metaRecord(exportedAt: number) {
  return { type: "meta" as const, version: EXPORT_VERSION, app: "folio" as const, exportedAt };
}

// 账户记录。safeCreds 须为已脱敏的 creds(由 route 经 lib/creds.ts safeView 算出:public 原样、semi 打码、无 secret)。
// manual 持仓(symbol/amount/usdValue)也是 public creds,随 creds 一并导出(P6.6.2,不再有独立 data 字段)。
export function accountRecord(account: AccountIn, safeCreds: Record<string, string>) {
  return {
    type: "account" as const,
    id: account.id,
    accountType: account.type,
    network: account.network ?? undefined,
    label: account.label,
    creds: safeCreds,
  };
}

export function groupRecord(g: GroupIn) {
  return { type: "group" as const, id: g.id, name: g.name, sortOrder: g.sortOrder };
}
export function membershipRecord(m: { accountId: string; groupId: string }) {
  return { type: "membership" as const, accountId: m.accountId, groupId: m.groupId };
}
export function snapshotRecord(s: SnapshotIn, balances: BalanceIn[]) {
  return {
    type: "snapshot" as const,
    accountId: s.accountId,
    takenAt: s.takenAt,
    totalUsd: s.totalUsd,
    balances: balances.map((b) => ({
      symbol: b.symbol,
      amount: b.amount,
      usdValue: b.usdValue,
      kind: b.kind,
      meta: safeParse(b.metaJson),
    })),
  };
}

// 一条记录 → 一行 NDJSON(含换行)。
export function ndjsonLine(record: unknown): string {
  return `${JSON.stringify(record)}\n`;
}
