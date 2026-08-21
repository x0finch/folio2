import { DefiMeta } from "@folio/connectors-basic";
import type { CacheStore } from "@folio/oracle-basic/ports";
import type { Effect } from "effect";
import { recordDefiLogos } from "../internal/defi-logo-store";

// DeFi 协议 logo 的同步记账(#126)。协议→图 URL 采集时就随余额 meta 落进了快照,这里把它收集出来、
// 写进 per-user 缓存(`defi-logo:<协议>`)—— 图片端点 `/api/logo/defi` 由此 O(1) 读,不再取全部
// 快照双重遍历。写在同步时(URL 现成、无网络),读在渲染时。best-effort(调用方吞错)。

type SnapshotLike = { balances: readonly { metaJson: string | null }[] };

// 从快照余额里收集 (protocol, protocolLogo) 对(纯函数)。同协议取首个带图者。
function collectDefiLogos(
  snapshots: readonly SnapshotLike[],
): { protocol: string; logo: string }[] {
  const byProtocol = new Map<string, string>();
  for (const s of snapshots) {
    for (const b of s.balances) {
      if (!b.metaJson) continue;
      let raw: unknown;
      try {
        raw = JSON.parse(b.metaJson);
      } catch {
        continue;
      }
      const r = DefiMeta.safeParse(raw);
      if (r.success && r.data.protocol && r.data.protocolLogo && !byProtocol.has(r.data.protocol)) {
        byProtocol.set(r.data.protocol, r.data.protocolLogo);
      }
    }
  }
  return [...byProtocol].map(([protocol, logo]) => ({ protocol, logo }));
}

// **出口是 Effect,不是 Promise**(同 platforms.ts):唯一的调用方是预热,它整段拼成一个 effect 再跑。
// userId 也不再收 —— per-user 的那层由调用方装配时给,这里只管「把收集到的图写进缓存」。
export const recordDefiLogosOf = (
  snapshots: readonly SnapshotLike[],
): Effect.Effect<void, never, CacheStore> => recordDefiLogos(collectDefiLogos(snapshots));
