// 纯逻辑(无 server-only import → 可单测)。把各实体映射成导出 NDJSON 记录(逐行一个 JSON)。
// 红线:accountRecord 按 secretKeys 剥掉密钥(apiKey/secret/passphrase),仅留非密钥(identifier)。

export const EXPORT_VERSION = 1;

interface AccountIn {
  id: string;
  type: string;
  network: string | null;
  label: string;
  dataJson: string | null;
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
  source: string;
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

// 账户:剥掉 secretKeys 指定的密钥字段,仅导出非密钥(地址 identifier 等)。
export function accountRecord(
  account: AccountIn,
  creds: Record<string, string>,
  secretKeys: readonly string[],
) {
  const safeCreds: Record<string, string> = {};
  for (const [k, v] of Object.entries(creds)) {
    if (!secretKeys.includes(k)) safeCreds[k] = v;
  }
  return {
    type: "account" as const,
    id: account.id,
    accountType: account.type,
    network: account.network ?? undefined,
    label: account.label,
    data: safeParse(account.dataJson),
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
      source: b.source,
      meta: safeParse(b.metaJson),
    })),
  };
}

// 一条记录 → 一行 NDJSON(含换行)。
export function ndjsonLine(record: unknown): string {
  return `${JSON.stringify(record)}\n`;
}
