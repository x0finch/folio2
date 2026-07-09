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
  // 与 aggregate.platformIdFromAccount 同口径(#37d 由 connectorId 直接归类);manual 无平台 key(跳过)。
  const exchangeConnectors = new Set(["binance", "okx"]);
  const perpConnectors = new Set(["hyperliquid"]);
  for (const a of accounts) {
    if (a.archivedAt != null) continue;
    const cid = a.connectorId;
    if (exchangeConnectors.has(cid)) keys.add(`exchange:${cid}`);
    else if (perpConnectors.has(cid)) keys.add(`perp:${cid}`);
    else if (cid !== "manual") keys.add(`chain:${a.network ?? cid}`);
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
