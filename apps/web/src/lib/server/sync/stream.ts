import { getLogger } from "@logtape/logtape";
import { Effect } from "effect";
import { syncRoundFor } from "./deps";
import { ndjsonRound } from "./ndjson";

const log = getLogger(["folio", "web", "sync"]);

// POST /api/sync —— 一轮同步的 NDJSON 流。userId 显式传入(与 ./run 的 handleSyncAccount 同理由)。
// 「跑」和「看」怎么拆开的在 ./ndjson.ts(纯逻辑,那里有单测)。
//
// **这一轮跑哪些账户由 `portfolioId` 定,而名单是服务端算的**(ADR 0047):客户端只说「我在看哪个
// 组合」,不递账户 id 名单。缺省 = 默认组合。抽屉里的单账户同步是另一条路(`./run`),它照旧收
// accountId —— 那本来就是 id 寻址的动作。
export const syncStream = Effect.fn("syncStream")(function* (userId: string, portfolioId?: string) {
  const round = syncRoundFor(userId, { portfolioId });
  return yield* ndjsonRound(round.results, {
    layer: round.layer,
    afterRound: round.afterRound,
    onFatal: (message) => log.error("sync stream failed", { userId, error: message }),
  });
});
