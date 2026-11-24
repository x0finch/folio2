import { DefiMeta } from "@folio/connectors-basic";
import type { Database, DbRequest } from "@folio/db";
import type { Effect } from "effect";
import { recordDefiLogos } from "@/lib/server/logos/store";

// Protocol logo URLs arrive in balance meta at sync time; cache them per user so the logo endpoint
// reads one key instead of scanning snapshots. Best-effort: the caller swallows errors.

type SnapshotLike = { balances: readonly { metaJson: string | null }[] };

// First protocol entry with a logo wins.
function collectDefiLogos(
  snapshots: readonly SnapshotLike[],
): { protocol: string; logo: string }[] {
  const byProtocol = new Map<string, string>();
  for (const s of snapshots) {
    for (const b of s.balances) {
      if (!b.metaJson) continue;
      let raw: unknown;
      try {
        raw = JSON.parse(b.metaJson);
      } catch {
        continue;
      }
      const r = DefiMeta.safeParse(raw);
      if (r.success && r.data.protocol && r.data.protocolLogo && !byProtocol.has(r.data.protocol)) {
        byProtocol.set(r.data.protocol, r.data.protocolLogo);
      }
    }
  }
  return [...byProtocol].map(([protocol, logo]) => ({ protocol, logo }));
}

export const recordDefiLogosOf = (
  snapshots: readonly SnapshotLike[],
): Effect.Effect<void, never, Database | DbRequest> => recordDefiLogos(collectDefiLogos(snapshots));
