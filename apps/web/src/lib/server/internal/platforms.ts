import { chainNamerOf } from "../../token-ref";
import { db } from "./db";
import { oracle } from "./oracle";

// 平台元数据门面(链 ∪ 场馆的 name+logo)经统一 Oracle 装配(#79)。读走 resolve(cache-only),写走 warm(sync 后)。

// sync 后预热:收集该用户出现的**链 key**,一次取整表缓存(命中未过期则跳过)。
// 只预热链键 —— 从快照余额的 tokenRef 采命名者(eip155:<id> / <slug>,同账户可跨多链)。
// 「是不是链」看右半边:`native` / `<ns>:<addr>` 才是链上寻址,不透明 id(binance/USDC、
// coingecko/usd-coin)不是。场馆的 name+logo 由连接器 manifest 自带,不查 CoinGecko(#52)。
export async function warmPlatformsForUser(userId: string): Promise<void> {
  const snapshots = await db.getLatestSnapshotByUser(userId);
  const keys = new Set<string>();
  for (const s of snapshots) {
    for (const b of s.balances) {
      const chain = chainNamerOf(b.tokenKey);
      if (chain) keys.add(chain);
    }
  }
  if (keys.size === 0) return;
  await oracle.platforms.warm([...keys]);
}
