import type { BalanceKind, Note } from "@folio/connectors-basic";
import { Effect } from "effect";
import { SEMI_PREFIX } from "@/lib/server/creds";
import { EXPORT_VERSION } from "./export";

// 纯导入逻辑(无 server-only import → 可单测,DB 经 deps 注入)。
// 单遍处理 NDJSON 记录;导出顺序保证 token→account→snapshot→manualActivity,
// 故引用某 id 的记录出现时,其 id map 已就绪。
//
// **合并式导入,幂等**(#204,A 方案):每类实体按**内容自然键** find-or-create(见 db 的 import* op)——
// token 按 ref、账户按 (connectorId+platform+label+creds)、快照按 (account,takenAt)、
// 手记活动按整条内容。命中既有 → 复用(其新 id 记进映射表),没有 → 建新行。于是:**反复导入同一文件
// 结果不变(不翻倍),导入不同文件则合并进来**。全程用新 id、按 userId 作用域去重,多用户安全。
//
// v3(#204):文件自带 Token 行(其 ref 嵌在里头)与手记账本;快照余额按 token_id(旧 id → 经 tokenMap 重映射)。
// **不兼容旧文件** —— 版本闸只收 v3,v1/v2 明确报「太旧」。
// 凭据(P6.6.1):重建存库 creds map —— public 字段真值原样;semi 字段(导出已打码)写成 `semi_<key>`
// 占位待补录;secret 文件里没有 → 不写。

export class ImportError extends Error {}

// 按暴露级别分类某 connector 的输入字段(由 route 用 registry 派生注入)。
interface InputKinds {
  publicKeys: string[];
  semiKeys: string[];
  secretKeys: string[];
}

interface ImportSnapshotBalance {
  tokenId?: string; // 身份锚(由 apply 经 tokenMap 重映射后传入);#244 起 DB 必填
  amount: number;
  usdValue: number;
  kind: BalanceKind;
  selfPrice?: number;
  platform?: string;
  meta?: Record<string, unknown>;
  note?: Note; // balance 级 note
}

interface ImportActivity {
  kind: "add" | "reduce" | "set";
  amount: number;
  price?: number | null;
  fee?: number | null;
  occurredAt: number;
  memo?: string | null;
  createdAt?: number;
}

// 所有 import* 都是 find-or-create(按各自的内容自然键去重),让反复导入 / 合并幂等。
export interface ImportDeps {
  categorize(connectorId: string): InputKinds;
  importToken(
    t: {
      symbol: string;
      name: string;
      logo?: string | null;
      providerLogo?: string | null;
      marketCapRank?: number | null;
    },
    refs: { namer: string; localName: string }[],
  ): Effect.Effect<{ id: string }>;
  importAccount(input: {
    connectorId: string;
    platform?: string;
    label: string;
    creds: string;
    archivedAt?: number | null;
  }): Effect.Effect<{ id: string }>;
  importSnapshot(
    accountId: string,
    input: { takenAt: number; totalUsd: number; note?: Note[]; balances: ImportSnapshotBalance[] },
  ): Effect.Effect<void>;
  importManualActivity(
    accountId: string,
    tokenId: string,
    input: ImportActivity,
  ): Effect.Effect<void>;
}

// 一次导入各类实体的写入计数。**路由把它原样回给客户端**(`{ imported: counts }`),
// 故导出:设置页导入复用它当返回类型(见 data-card),不另起一份。
export interface ImportCounts {
  tokens: number;
  accounts: number;
  snapshots: number;
  activities: number;
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

const asRefs = (v: unknown): { namer: string; localName: string }[] =>
  Array.isArray(v)
    ? v.flatMap((r) =>
        r && typeof r === "object" && typeof r.namer === "string" && typeof r.localName === "string"
          ? [{ namer: r.namer, localName: r.localName }]
          : [],
      )
    : [];

export function createImporter(deps: ImportDeps) {
  const tokenMap = new Map<string, string>(); // 导出 token id → 新建 id
  const accountMap = new Map<string, string>();
  const counts: ImportCounts = {
    tokens: 0,
    accounts: 0,
    snapshots: 0,
    activities: 0,
  };
  let metaSeen = false;

  // **一条记录 = 一个 effect**(#394 T7)。四个写口都在 `R` 通道上(由路由那一次装配供上),
  // 所以整条导入 —— 读流、解析、写库 —— 从头到尾一个 effect,一次装配。
  // 以前是 `async apply` 里 `await deps.xxx()`,而那四个 dep 各自经过渡门面各装一次 layer:
  // 一个几万行的导入文件就是几万次装配。
  const apply = (rec: Record<string, unknown>): Effect.Effect<void, ImportError> =>
    Effect.gen(function* () {
      if (rec.type === "meta") {
        const v = rec.version;
        if (v !== EXPORT_VERSION) {
          // 只收当前版本;旧文件明确报「太旧」而不是崩(#204)。
          const hint =
            typeof v === "number" && v < EXPORT_VERSION
              ? `导出文件太旧(v${v}),本版本只支持 v${EXPORT_VERSION};请用新版本重新导出`
              : `unsupported export version: ${String(v)}(expected v${EXPORT_VERSION})`;
          return yield* Effect.fail(new ImportError(hint));
        }
        metaSeen = true;
        return;
      }
      if (!metaSeen) {
        return yield* Effect.fail(
          new ImportError("missing meta header (first line must be type:meta)"),
        );
      }

      switch (rec.type) {
        case "token": {
          const created = yield* deps.importToken(
            {
              symbol: String(rec.symbol ?? ""),
              name: String(rec.name ?? rec.symbol ?? ""),
              logo: typeof rec.logo === "string" ? rec.logo : null,
              providerLogo: typeof rec.providerLogo === "string" ? rec.providerLogo : null,
              marketCapRank: typeof rec.marketCapRank === "number" ? rec.marketCapRank : null,
            },
            asRefs(rec.refs),
          );
          if (typeof rec.id === "string") tokenMap.set(rec.id, created.id);
          counts.tokens++;
          break;
        }
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
          const created = yield* deps.importAccount({
            connectorId,
            // v3 线格式字段名为 `platform`(v2 是 network);库里那一列 #203 起叫 platform。
            platform: typeof rec.platform === "string" ? rec.platform : undefined,
            label: String(rec.label ?? ""),
            creds: JSON.stringify(stored),
            // 归档态随文件带进 find-or-create(见 importAccount:命中既有则对齐归档)。
            archivedAt: typeof rec.archivedAt === "number" ? rec.archivedAt : undefined,
          });
          if (typeof rec.id === "string") accountMap.set(rec.id, created.id);
          counts.accounts++;
          break;
        }
        case "snapshot": {
          const accountId = accountMap.get(String(rec.accountId));
          if (accountId) {
            const rawBalances = Array.isArray(rec.balances) ? rec.balances : [];
            // 余额的 token_id 是导出侧旧 id → 经 tokenMap 重映射;映射不到的行丢弃(#244 起 token_id 必填,
            // 且合法 v3 文件里每条余额的 token 都在前面导出过 → 恒能映射)。
            const balances: ImportSnapshotBalance[] = rawBalances.flatMap((b) => {
              const oldId = typeof b.tokenId === "string" ? b.tokenId : undefined;
              const tokenId = oldId ? tokenMap.get(oldId) : undefined;
              if (!tokenId) return [];
              return [{ ...(b as ImportSnapshotBalance), tokenId }];
            });
            yield* deps.importSnapshot(accountId, {
              takenAt: Number(rec.takenAt),
              totalUsd: Number(rec.totalUsd),
              note: Array.isArray(rec.note) ? (rec.note as Note[]) : undefined,
              balances,
            });
            counts.snapshots++;
          }
          break;
        }
        case "manualActivity": {
          const accountId = accountMap.get(String(rec.accountId));
          const tokenId = tokenMap.get(String(rec.tokenId));
          if (accountId && tokenId) {
            yield* deps.importManualActivity(accountId, tokenId, {
              kind: rec.kind as ImportActivity["kind"],
              amount: Number(rec.amount),
              price: typeof rec.price === "number" ? rec.price : null,
              fee: typeof rec.fee === "number" ? rec.fee : null,
              occurredAt: Number(rec.occurredAt),
              memo: typeof rec.memo === "string" ? rec.memo : null,
              createdAt: typeof rec.createdAt === "number" ? rec.createdAt : undefined,
            });
            counts.activities++;
          }
          break;
        }
      }
    });
  return { apply, counts };
}
