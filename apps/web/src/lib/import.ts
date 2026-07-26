import type { BalanceKind } from "@folio/connectors-basic";
import { SEMI_PREFIX } from "./creds";
import { EXPORT_VERSION } from "./export";

// 纯导入逻辑(无 server-only import → 可单测,DB 经 deps 注入)。
// 单遍处理 NDJSON 记录(导出顺序保证 accounts→groups→memberships→snapshots,故 id map 先就绪);
// **id 重映射**(oldId→newId)避免与现有数据冲突、支持重复导入。
// 凭据(P6.6.1):重建存库 creds map —— public 字段真值原样;semi 字段(导出已打码)写成 `semi_<key>`
// 占位待补录;secret 文件里没有 → 不写。缺凭据态由 isComplete(inputs, creds) 在内存判定(见 sync)。

export class ImportError extends Error {}

// 按暴露级别分类某 connector 的输入字段(由 route 用 registry 派生注入)。
interface InputKinds {
  publicKeys: string[];
  semiKeys: string[];
  secretKeys: string[];
}

interface ImportSnapshotBalance {
  symbol: string;
  amount: number;
  usdValue: number;
  kind: BalanceKind;
  platform?: string; // v2 的文件没有它 —— 缺席即空,下次同步补上
  meta?: Record<string, unknown>;
}

export interface ImportDeps {
  categorize(connectorId: string): InputKinds;
  createAccount(input: {
    connectorId: string;
    platform?: string;
    label: string;
    creds: string;
  }): Promise<{ id: string }>;
  createGroup(input: { name: string; sortOrder?: number }): Promise<{ id: string }>;
  addAccountToGroup(accountId: string, groupId: string): Promise<void>;
  writeSnapshot(
    accountId: string,
    input: { takenAt: number; totalUsd: number; balances: ImportSnapshotBalance[] },
  ): Promise<void>;
}

interface ImportCounts {
  accounts: number;
  groups: number;
  memberships: number;
  snapshots: number;
}

// 解析一行 NDJSON → 记录对象;空行/坏 JSON → null(流式读会有不完整行,调用方按需缓冲)。
export function parseImportLine(line: string): Record<string, unknown> | null {
  const s = line.trim();
  if (!s) return null;
  try {
    const v = JSON.parse(s);
    return v && typeof v === "object" ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

export function createImporter(deps: ImportDeps) {
  const accountMap = new Map<string, string>(); // 导出 id → 新建 id
  const groupMap = new Map<string, string>();
  const counts: ImportCounts = { accounts: 0, groups: 0, memberships: 0, snapshots: 0 };
  let metaSeen = false;

  async function apply(rec: Record<string, unknown>): Promise<void> {
    if (rec.type === "meta") {
      if (rec.version !== EXPORT_VERSION) {
        throw new ImportError(`unsupported export version: ${String(rec.version)}`);
      }
      metaSeen = true;
      return;
    }
    if (!metaSeen) throw new ImportError("missing meta header (first line must be type:meta)");

    switch (rec.type) {
      case "account": {
        const connectorId = String(rec.connectorId);
        const fileCreds = (rec.creds as Record<string, string> | undefined) ?? {};
        const { publicKeys, semiKeys } = deps.categorize(connectorId);
        // 重建存库 map:public 真值原样;semi(导出已打码)写 `semi_<key>` 占位待补录;secret 文件里没有。
        const stored: Record<string, string> = {};
        for (const [k, v] of Object.entries(fileCreds)) {
          if (publicKeys.includes(k)) stored[k] = v;
          else if (semiKeys.includes(k)) stored[SEMI_PREFIX + k] = v;
        }
        const created = await deps.createAccount({
          connectorId,
          // 线格式的字段名仍是 `network`(见 export.ts 的注释);库里那一列 #203 起叫 platform。
          platform: typeof rec.network === "string" ? rec.network : undefined,
          label: String(rec.label ?? ""),
          creds: JSON.stringify(stored),
        });
        if (typeof rec.id === "string") accountMap.set(rec.id, created.id);
        counts.accounts++;
        break;
      }
      case "group": {
        const created = await deps.createGroup({
          name: String(rec.name ?? ""),
          sortOrder: typeof rec.sortOrder === "number" ? rec.sortOrder : undefined,
        });
        if (typeof rec.id === "string") groupMap.set(rec.id, created.id);
        counts.groups++;
        break;
      }
      case "membership": {
        const accountId = accountMap.get(String(rec.accountId));
        const groupId = groupMap.get(String(rec.groupId));
        if (accountId && groupId) {
          await deps.addAccountToGroup(accountId, groupId);
          counts.memberships++;
        }
        break;
      }
      case "snapshot": {
        const accountId = accountMap.get(String(rec.accountId));
        if (accountId) {
          await deps.writeSnapshot(accountId, {
            takenAt: Number(rec.takenAt),
            totalUsd: Number(rec.totalUsd),
            balances: Array.isArray(rec.balances) ? (rec.balances as ImportSnapshotBalance[]) : [],
          });
          counts.snapshots++;
        }
        break;
      }
    }
  }

  return { apply, counts };
}
