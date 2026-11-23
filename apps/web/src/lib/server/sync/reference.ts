import { Database, type DbRequest, type SnapshotWithBalances } from "@folio/db";
import { Oracle } from "@folio/oracle";
import { getLogger } from "@logtape/logtape";
import { Effect } from "effect";
import type { ReferenceJob } from "@/lib/server/jobs/message";
import { forUser } from "@/lib/server/runtime";
import { recordDefiLogosOf } from "./defi-logos";
import { warmPlatforms } from "./platforms";

// Non-price reference warming: fx, platforms, catalogue, DeFi logos. One message each so each gets
// its own CPU / subrequest budget. Each is TTL-gated and degrades on upstream failure, so
// idempotent.

const log = getLogger(["folio", "jobs", "reference"]);

type Work = Effect.Effect<void, never, Database | Oracle | DbRequest>;

/** All currencies in one call; no upstream inside the 6h TTL. */
const refreshFx: Work = Effect.flatMap(Oracle, (o) => o.fx.warm());

/**
 * The only path that keeps the catalogue current: writes never refresh it and the picker only does
 * when opened, so without this newly top-1000 tokens would never be recognised. Weekly TTL.
 */
const refreshCatalogue: Work = Effect.flatMap(Oracle, (o) => o.tokens.refreshCatalogue()).pipe(
  Effect.flatMap((rows) => Effect.sync(() => log.debug("catalogue warmed", { rows }))),
);

const withLatest = (work: (snapshots: SnapshotWithBalances[]) => Work): Work =>
  Effect.flatMap(
    Effect.flatMap(Database, (db) => db.snapshots.latest()),
    work,
  );

// All four carry only `userId`, provided by `forUser`.
const workOf = (kind: ReferenceJob["kind"]): Work => {
  switch (kind) {
    case "fx":
      return refreshFx;
    case "platforms":
      return withLatest(warmPlatforms);
    case "catalogue":
      return refreshCatalogue;
    case "defi-logos":
      return withLatest(recordDefiLogosOf);
  }
};

/** Fails only on defects (D1, bugs); upstream errors are already degraded. The runner retries. */
export const runReferenceJob = (job: ReferenceJob): Effect.Effect<void, Error> =>
  forUser(job.userId, workOf(job.kind));
