import { db } from "./db";
import { oracle } from "./oracle";

// 平台元数据门面(链 ∪ 场馆的 name+logo)经统一 Oracle 装配(#79)。读走 resolve(cache-only),写走 warm(sync 后)。

// sync 后预热:收集该用户出现的**链 key**,一次取整表缓存(命中未过期则跳过)。
// 只预热链键 —— 从快照余额的 tokenKey 前缀采(chain:<slug> / eip155:<id>,同账户可跨多链)。
// 场馆键(exchange:/perp:/manual)不再预热:其 name+logo 由连接器 manifest 自带,读时直接取,不查 CoinGecko(#52)。
export async function warmPlatformsForUser(userId: string): Promise<void> {
  const snapshots = await db.getLatestSnapshotByUser(userId);
  const keys = new Set<string>();
  for (const s of snapshots) {
    for (const b of s.balances) {
      const tk = b.tokenKey;
      if (!tk) continue;
      const slash = tk.indexOf("/");
      const prefix = slash > 0 ? tk.slice(0, slash) : "";
      if (prefix.startsWith("eip155:") || prefix.startsWith("chain:")) keys.add(prefix);
    }
  }
  if (keys.size === 0) return;
  await oracle.platforms.warm([...keys]);
}
