import { Oracle } from "@folio/oracle";
import type { PlatformMeta } from "@folio/oracle-basic";
import { Effect } from "effect";
import { z } from "zod";

// Batch-resolves chain platform display metadata by chain key (the client computes the key set).

export const PlatformMetaInput = z.object({
  chainIds: z.array(z.string()),
});

export const handleResolvePlatformMeta = Effect.fn("resolvePlatformMeta")(function* (
  data: z.infer<typeof PlatformMetaInput>,
) {
  const unique = [...new Set(data.chainIds)];
  if (unique.length === 0) return { platformMeta: [] as [string, PlatformMeta][] };
  const meta = yield* Effect.flatMap(Oracle, (o) => o.platforms.resolve(unique));
  return { platformMeta: [...meta] as [string, PlatformMeta][] };
});
