import type { DbRequest, SnapshotWithBalances } from "@folio/db";
import { Oracle } from "@folio/oracle";
import { Effect } from "effect";
import { connectorPlatformMeta } from "@/lib/server/connectors/platform";

// Warms chain metadata for chains seen in the snapshots (only stale/missing keys). Keys a connector
// recognises carry their own name+logo in the manifest, so CoinGecko is skipped for them.
// Snapshots are passed in because the caller already read them.
export const warmPlatforms = (
  snapshots: readonly SnapshotWithBalances[],
): Effect.Effect<void, never, Oracle | DbRequest> =>
  Effect.gen(function* () {
    const keys = new Set<string>();
    for (const s of snapshots) {
      for (const b of s.balances) {
        if (b.platform && !connectorPlatformMeta(b.platform)) keys.add(b.platform);
      }
    }
    if (keys.size === 0) return;
    yield* Effect.flatMap(Oracle, (o) => o.platforms.warm([...keys]));
  });
