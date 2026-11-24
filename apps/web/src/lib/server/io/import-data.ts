import type { ConnectorId } from "@folio/connectors";
import { Database, type DbRequest, type SnapshotBalanceInput } from "@folio/db";
import { type Context, Effect } from "effect";
import { ConnectorRegistry } from "@/lib/server/connectors/registry";
import { categorizeFields } from "@/lib/server/creds";
import { createImporter, type ImportCounts, type ImportDeps, parseImportLine } from "./import";

// POST /api/import: streams NDJSON to rebuild accounts / history in one pass with id remapping. Accounts with secrets
// import with encCredentials=null (missing credentials, to be completed).

// `request` is the request's connection and user; `ImportDeps`' `R` is `never`, so db ops get it provided here.
const depsFrom = (
  transfer: Database["transfer"],
  specs: ConnectorRegistry["specs"],
  request: Context.Context<DbRequest>,
): ImportDeps => ({
  categorize: (connectorId) => {
    const f = categorizeFields(specs[connectorId as ConnectorId] ?? []);
    return { publicKeys: f.public, semiKeys: f.semi, secretKeys: f.secret };
  },
  importToken: (t, refs) =>
    Effect.map(transfer.importToken(t, refs), (id) => ({ id })).pipe(Effect.provide(request)),
  importAccount: (input) =>
    transfer
      .importAccount({ ...input, connectorId: input.connectorId as ConnectorId })
      .pipe(Effect.provide(request)),
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
        .pipe(Effect.provide(request), Effect.orDie),
    ),
  importManualActivity: (accountId, tokenId, input) =>
    Effect.asVoid(
      transfer
        .importManualActivity(accountId, tokenId, input)
        .pipe(Effect.provide(request), Effect.orDie),
    ),
});

export const importData = Effect.fn("importData")(function* (
  reader: ReadableStreamDefaultReader<Uint8Array>,
) {
  return yield* Effect.gen(function* () {
    const importer = createImporter(
      depsFrom(
        (yield* Database).transfer,
        (yield* ConnectorRegistry).specs,
        yield* Effect.context<DbRequest>(),
      ),
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

// Re-exported so clients depend on what the API returns; the shape's source is ./import.
export type { ImportCounts };
