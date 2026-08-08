import type { SnapshotWithBalances } from "@folio/db";
import { PlatformService } from "@folio/oracle";
import { Effect } from "effect";
import { connectorPlatformMeta } from "./connector-platform";

// 平台元数据(链 ∪ 场馆的 name+logo)。**按用户**(#202b):与汇率、代币目录同住一张
// per-user 缓存(`platform:<键>` 键)。读走 resolve(cache-only、一次批量读、零网络),
// 写走 warm(同步后,一个批次写回)。

// sync 后预热:收集该用户出现的**链 key**,拉一次整张链表、**只写这几个键**(命中未过期则跳过)。
// 平台键直接读余额行(provider 报的,#193),不再从 tokenRef 拆。
// 「哪些要查 CoinGecko」用与读路径装饰同一条判据(见 overview-model):键认得出连接器的
// (binance/okx/hyperliquid/manual,以及 slug 与连接器同名的 bitcoin/solana…)其 name+logo
// 由 manifest 自带,不查 CoinGecko(#52);余下的才是要预热的链键。
// **出口是 Effect,不是 Promise**:唯一的调用方(预热)现在把自己整段拼成一个 effect 再交给边缘跑,
// 中间转一次 Promise 就多切一次上下文。
// **快照由调用方传进来**(#394 T5):它刚为别的用途读过同一批,自己再读一遍是白发一次 D1 查询 ——
// 以前看不出来是因为两处各自 `db.getLatestSnapshotByUser(userId)`,一次请求里读两遍这件事藏在门面后面。
export const warmPlatforms = (
  snapshots: readonly SnapshotWithBalances[],
): Effect.Effect<void, never, PlatformService> =>
  Effect.gen(function* () {
    const keys = new Set<string>();
    for (const s of snapshots) {
      for (const b of s.balances) {
        if (b.platform && !connectorPlatformMeta(b.platform)) keys.add(b.platform);
      }
    }
    if (keys.size === 0) return;
    yield* Effect.flatMap(PlatformService, (p) => p.warm([...keys]));
  });
