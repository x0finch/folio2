import { DefiMeta } from "@folio/connectors-basic";
import { recordDefiLogos } from "./defi-logo-store";
import { runOracle } from "./oracle";

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

export async function recordDefiLogosForUser(
  userId: string,
  snapshots: readonly SnapshotLike[],
): Promise<void> {
  await runOracle(userId, recordDefiLogos(collectDefiLogos(snapshots)));
}
