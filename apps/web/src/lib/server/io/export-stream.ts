import { Database, type DbRequest, type SnapshotBalance } from "@folio/db";
import { Effect, Option, Stream } from "effect";
import { ConnectorRegistry } from "@/lib/server/connectors/registry";
import { readStoredCreds, safeView } from "@/lib/server/creds";
import {
  accountRecord,
  manualActivityRecord,
  metaRecord,
  ndjsonLine,
  snapshotRecord,
  tokenRecord,
} from "./export";

// The NDJSON export stream; the route only authenticates and runs it once. Lives here so the pagination boundaries
// are testable (tests/server/export-stream.test.ts).

// Snapshots per page: with inArray (<= 50 ids) for balances, well under D1's 100 bound-parameter limit.
const SNAPSHOT_PAGE = 50;

const encoder = new TextEncoder();

// The four export sections as one Effect Stream: `concat` orders them, `paginate` pages, failures propagate
// through the stream. Services are resolved before the stream is built, so its `R` is `never`; the request's `DbRequest`
// is captured then and provided when the stream finishes, because the body is pulled after the handler returns.
export const exportStream = (): Effect.Effect<
  ReadableStream<Uint8Array>,
  never,
  ConnectorRegistry | Database | DbRequest
> =>
  Effect.gen(function* () {
    const { transfer, accounts, snapshots, manual } = yield* Database;
    const specsByType = (yield* ConnectorRegistry).specs;
    const request = yield* Effect.context<DbRequest>();

    const meta = Stream.make(metaRecord(Date.now())); // first line: version etc.

    // Tokens come before snapshots / activity: those reference token_id, and the single-pass import builds the Token map first.
    const tokens = Stream.fromIterableEffect(transfer.listTokensForExport()).pipe(
      Stream.map(tokenRecord),
    );

    // Safe projection (no decryption): public as-is, semi masked, secret dropped; never export full keys.
    const accountLines = Stream.fromIterableEffect(accounts.list()).pipe(
      Stream.mapEffect((a) =>
        // Undecryptable creds export as "no credentials" so one bad row doesn't abort the export (the only self-rescue path).
        Effect.map(accounts.getRawCreds(a.id), (raw) => {
          const stored = readStoredCreds(raw) ?? {};
          return accountRecord(a, safeView(specsByType[a.connectorId] ?? [], stored));
        }),
      ),
    );

    // Snapshots: paged, balances fetched per page and streamed out, so memory stays constant. `none` means no next page.
    const snapshotLines = Stream.paginate(0, (offset: number) =>
      Effect.gen(function* () {
        const page = yield* snapshots.listPage(SNAPSHOT_PAGE, offset);
        const pageBalances =
          page.length === 0 ? [] : yield* snapshots.balancesFor(page.map((s) => s.id));
        const bySnapshot = new Map<string, SnapshotBalance[]>();
        for (const b of pageBalances) {
          const arr = bySnapshot.get(b.snapshotId);
          if (arr) arr.push(b);
          else bySnapshot.set(b.snapshotId, [b]);
        }
        // A short page (including empty) is the last.
        const next =
          page.length < SNAPSHOT_PAGE ? Option.none<number>() : Option.some(offset + SNAPSHOT_PAGE);
        return [page.map((s) => snapshotRecord(s, bySnapshot.get(s.id) ?? [])), next] as const;
      }),
    );

    // Manual ledger last: accountId / tokenId reference the accounts / tokens written above.
    const activities = Stream.fromIterableEffect(manual.listAllActivity()).pipe(
      Stream.map(manualActivityRecord),
    );

    const bytes = meta.pipe(
      Stream.concat(tokens),
      Stream.concat(accountLines),
      Stream.concat(snapshotLines),
      Stream.concat(activities),
      Stream.map((record: unknown) => encoder.encode(ndjsonLine(record))),
      Stream.provideContext(request),
    );
    return bytes.pipe(Stream.toReadableStream());
  });

// Business effect of GET /api/export; the route only authenticates and runs `runForUser`.
export const exportData = Effect.fn("exportData")(function* () {
  return yield* exportStream();
});
