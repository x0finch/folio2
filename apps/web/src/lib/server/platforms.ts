import { env } from "cloudflare:workers";
import { createPlatformStore } from "@folio/db";
import { createCoinGeckoPlatformSource, createPlatforms, type Platforms } from "@folio/platforms";
import { db } from "./db";

// 平台元数据门面(链 ∪ 场馆的 name+logo)。读走 resolve(cache-only),写走 warm(sync 后)。
export function buildPlatforms(bindings: Cloudflare.Env): Platforms {
  return createPlatforms({
    source: createCoinGeckoPlatformSource({ apiKey: bindings.COINGECKO_API_KEY || undefined }),
    store: createPlatformStore(bindings),
  });
}

// sync 后预热:收集该用户出现的链 key,一次取整表缓存(命中未过期则跳过)。
// 链 key 与 aggregate.platformOf 同口径:onchain 账户 → chain:<network|specific>;
// 外加 EVM 多链的 tokenKey 前缀(eip155:<id>)—— 同一 onchain 账户可跨多条 EVM 链。
export async function warmPlatformsForUser(userId: string): Promise<void> {
  const [accounts, snapshots] = await Promise.all([
    db.listAccountsByUser(userId),
    db.getLatestSnapshotByUser(userId),
  ]);
  const keys = new Set<string>();
  for (const a of accounts) {
    if (a.archivedAt != null) continue;
    if (a.type.startsWith("onchain_")) {
      const specific = a.type.slice(a.type.indexOf("_") + 1);
      keys.add(`chain:${a.network ?? specific}`);
    }
  }
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
  await buildPlatforms(env).warm([...keys]);
}
