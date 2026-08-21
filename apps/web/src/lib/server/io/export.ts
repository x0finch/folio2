// 纯逻辑(无 server-only import → 可单测)。把各实体映射成导出 NDJSON 记录(逐行一个 JSON)。
// 红线:account 的 safeCreds 由 lib/creds.ts safeView 在 route 算好后传入(secret 丢、semi 打码、public 留)。

// v3(#204):不再兼容旧文件。快照的 symbol/tokenRef 两列已删(#243),身份只剩 token_id ——
// 于是文件必须自带 **Token 行**(其 ref 嵌在里头)与**手记账本**,否则导出一堆指向空气的 token_id。
// 导入按版本闸只收 v3、旧文件明确报「太旧」。流内顺序:meta → token → account →
// snapshot → activity(单遍导入据此建 old→new 映射,后来的记录引用先到的 id)。
export const EXPORT_VERSION = 3;

interface TokenIn {
  id: string;
  symbol: string;
  name: string;
  logo: string | null;
  providerLogo: string | null;
  marketCapRank: number | null;
  refs: { namer: string; localName: string }[];
}
interface AccountIn {
  id: string;
  connectorId: string;
  platform: string | null;
  label: string;
  archivedAt: number | null;
}
interface SnapshotIn {
  accountId: string;
  takenAt: number;
  totalUsd: number;
  note: string | null; // snapshots.note(账户级 Note[] 的 JSON)
}
interface BalanceIn {
  tokenId: string | null; // 身份锚(#243 起余额只靠它);#244 起 DB 必填,实际恒有值
  amount: number;
  usdValue: number;
  kind: string;
  selfPrice: number | null; // 估值原料(现推用),随行导
  platform: string | null;
  metaJson: string | null; // perp coin 等 typed meta
  note: string | null; // balance 级 Note 的 JSON
}
interface ActivityIn {
  accountId: string;
  tokenId: string | null;
  kind: string;
  amount: number;
  price: number | null;
  fee: number | null;
  occurredAt: number;
  memo: string | null;
  createdAt: number; // 保留:同 occurredAt 的折叠顺序靠它(deriveAmount)
}

function safeParse(json: string | null): unknown {
  if (!json) return undefined;
  try {
    return JSON.parse(json);
  } catch {
    return undefined;
  }
}

// 首行:版本号等关键信息,供导入做版本闸判断。
export function metaRecord(exportedAt: number) {
  return { type: "meta" as const, version: EXPORT_VERSION, app: "folio" as const, exportedAt };
}

// Token 记录(#204):ref 嵌在里头,同余额嵌在快照里。价 facet / self_price 不导(见 db 层 listTokensForExport)。
export function tokenRecord(t: TokenIn) {
  return {
    type: "token" as const,
    id: t.id,
    symbol: t.symbol,
    name: t.name,
    logo: t.logo ?? undefined,
    providerLogo: t.providerLogo ?? undefined,
    marketCapRank: t.marketCapRank ?? undefined,
    refs: t.refs,
  };
}

// 账户记录。safeCreds 须为已脱敏的 creds(由 route 经 lib/creds.ts safeView 算出:public 原样、semi 打码、无 secret)。
// manual 的持仓 #203 起不在 creds 里(creds 只剩 `{tokens:"[]"}`)—— 它的身份/账本走本次新增的
// token 记录 + activity 记录。归档态随 `archivedAt` 带走,否则归档账户导入回来会变回活跃(#204)。
export function accountRecord(account: AccountIn, safeCreds: Record<string, string>) {
  return {
    type: "account" as const,
    id: account.id,
    connectorId: account.connectorId,
    // v3 起字段名跟库里对齐叫 `platform`(v2 的旧名 `network` 随本次版本提升一并改)。
    platform: account.platform ?? undefined,
    label: account.label,
    archivedAt: account.archivedAt ?? undefined, // 有值即归档;导入据此重新归档
    creds: safeCreds,
  };
}

export function snapshotRecord(s: SnapshotIn, balances: BalanceIn[]) {
  return {
    type: "snapshot" as const,
    accountId: s.accountId,
    takenAt: s.takenAt,
    totalUsd: s.totalUsd,
    note: safeParse(s.note),
    balances: balances.map((b) => ({
      tokenId: b.tokenId ?? undefined,
      amount: b.amount,
      usdValue: b.usdValue,
      kind: b.kind,
      selfPrice: b.selfPrice ?? undefined,
      platform: b.platform ?? undefined,
      meta: safeParse(b.metaJson),
      note: safeParse(b.note),
    })),
  };
}

// 手记活动记录(#204):扁平记录。accountId/tokenId 是导出侧旧 id,导入各自重映射。
// 类型名带 `manual` 前缀 —— 它只装 `manual_activity`,别用泛名以免与将来别的「活动」概念混。
export function manualActivityRecord(a: ActivityIn) {
  return {
    type: "manualActivity" as const,
    accountId: a.accountId,
    tokenId: a.tokenId ?? undefined,
    kind: a.kind,
    amount: a.amount,
    price: a.price ?? undefined,
    fee: a.fee ?? undefined,
    occurredAt: a.occurredAt,
    memo: a.memo ?? undefined,
    createdAt: a.createdAt,
  };
}

// 一条记录 → 一行 NDJSON(含换行)。
export function ndjsonLine(record: unknown): string {
  return `${JSON.stringify(record)}\n`;
}
