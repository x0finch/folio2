import { Oracle } from "@folio/oracle";
import type { PlatformMeta } from "@folio/oracle-basic";
import { Effect } from "effect";
import { z } from "zod";

// 链平台展示元数据(FOL-54):按 chain key 批量 resolve,与 `scopedSnapshotMaterials` 里
// `platforms.resolve(overviewChainIds(...))` 同路 —— 键集由客户端从快照原料算好再传入。

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
