import type { ConnectorId } from "@folio/connectors";
import { Database, type SnapshotBalanceInput } from "@folio/db";
import { Effect } from "effect";
import { ConnectorRegistry } from "@/lib/server/connectors/registry";
import { categorizeFields } from "@/lib/server/creds";
import { createImporter, type ImportCounts, type ImportDeps, parseImportLine } from "./import";

// POST /api/import —— 流式读 NDJSON 重建账户/分组/历史(单遍 + id 重映射)。
// CEX 账户(有 secret 输入、导出已剥密钥)→ encCredentials=null = 缺凭据态,待补录。

const depsFrom = (
  transfer: Database["transfer"],
  specs: ConnectorRegistry["specs"],
): ImportDeps => ({
  categorize: (connectorId) => {
    const f = categorizeFields(specs[connectorId as ConnectorId] ?? []);
    return { publicKeys: f.public, semiKeys: f.semi, secretKeys: f.secret };
  },
  importToken: (t, refs) => Effect.map(transfer.importToken(t, refs), (id) => ({ id })),
  importAccount: (input) =>
    transfer.importAccount({ ...input, connectorId: input.connectorId as ConnectorId }),
  importSnapshot: (accountId, input) =>
    Effect.asVoid(
      transfer
        .importSnapshot(accountId, {
          ...input,
          balances: input.balances.map((b) => ({
            ...b,
            kind: b.kind as SnapshotBalanceInput["kind"],
          })),
        })
        .pipe(Effect.orDie),
    ),
  importManualActivity: (accountId, tokenId, input) =>
    Effect.asVoid(transfer.importManualActivity(accountId, tokenId, input).pipe(Effect.orDie)),
});

export const importData = Effect.fn("importData")(function* (
  reader: ReadableStreamDefaultReader<Uint8Array>,
) {
  return yield* Effect.gen(function* () {
    const importer = createImporter(
      depsFrom((yield* Database).transfer, (yield* ConnectorRegistry).specs),
    );
    const decoder = new TextDecoder();
    let buffer = "";
    for (;;) {
      const { done, value } = yield* Effect.promise(() => reader.read());
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let nl = buffer.indexOf("\n");
      while (nl >= 0) {
        const rec = parseImportLine(buffer.slice(0, nl));
        buffer = buffer.slice(nl + 1);
        if (rec) yield* importer.apply(rec);
        nl = buffer.indexOf("\n");
      }
    }
    const last = parseImportLine(buffer);
    if (last) yield* importer.apply(last);
    return importer.counts;
  }).pipe(
    Effect.map((counts) => ({ kind: "ok", counts }) as const),
    Effect.catchAll((e) => Effect.succeed({ kind: "rejected", message: e.message } as const)),
    Effect.catchAllDefect((d) =>
      Effect.succeed({
        kind: "failed",
        message: d instanceof Error ? d.message : String(d),
      } as const),
    ),
  );
});

// 导入结果计数由 /api/import 回给 UI(见 -settings/data-card)。形状的事实源在 ./import,
// 但客户端只该认「这条 API 返回什么」,所以从这里转出。
export type { ImportCounts };
