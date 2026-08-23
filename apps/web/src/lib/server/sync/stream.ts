import { getLogger } from "@logtape/logtape";
import { Effect } from "effect";
import { syncRoundFor } from "./deps";
import { ndjsonRound } from "./ndjson";

const log = getLogger(["folio", "web", "sync"]);

// POST /api/sync —— 全量同步 NDJSON 流。userId 显式传入(与 ./run 的 handleSyncAccount 同理由)。
// 「跑」和「看」怎么拆开的在 ./ndjson.ts(纯逻辑,那里有单测)。
export const syncStream = Effect.fn("syncStream")(function* (userId: string) {
  const round = syncRoundFor(userId);
  return yield* ndjsonRound(round.results, {
    layer: round.layer,
    afterRound: round.afterRound,
    onFatal: (message) => log.error("sync stream failed", { userId, error: message }),
  });
});
