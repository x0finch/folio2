import { connectorPlatformMeta } from "./connector-platform";
import { db } from "./db";
import { oracleFor } from "./oracle2";

// 平台元数据(链 ∪ 场馆的 name+logo)。**按用户**(#202b):与汇率、代币目录同住一张
// per-user 缓存(`platform:<键>` 键)。读走 resolve(cache-only,零网络),写走 warm(同步后)。

// sync 后预热:收集该用户出现的**链 key**,拉一次整张链表、**只写这几个键**(命中未过期则跳过)。
// 平台键直接读余额行(provider 报的,#193),不再从 tokenRef 拆。
// 「哪些要查 CoinGecko」用与读路径装饰同一条判据(见 overview-model):键认得出连接器的
// (binance/okx/hyperliquid/manual,以及 slug 与连接器同名的 bitcoin/solana…)其 name+logo
// 由 manifest 自带,不查 CoinGecko(#52);余下的才是要预热的链键。
export async function warmPlatformsForUser(userId: string): Promise<void> {
  const snapshots = await db.getLatestSnapshotByUser(userId);
  const keys = new Set<string>();
  for (const s of snapshots) {
    for (const b of s.balances) {
      if (b.platform && !connectorPlatformMeta(b.platform)) keys.add(b.platform);
    }
  }
  if (keys.size === 0) return;
  await oracleFor(userId).platforms.warm([...keys]);
}
