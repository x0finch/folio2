import { DefiMeta } from "@folio/connectors-basic";
import { db } from "./db";

// 协议 logo 上游 URL 的服务端解析(#126):从该用户最新快照里,按 protocol 名找到带 protocolLogo
// 的 defi 余额 meta,取其 URL。
//
// **不另存 protocol→logo 映射表**:logo URL 采集时就随 meta 落进了快照(见 DefiMeta.protocolLogo /
// rabby parse),快照即事实源。省掉一层存储/warm/迁移,隐私性不变 —— 仍是服务端解析、按用户收口,
// 客户端零第三方 CDN(ADR 0008)。首个命中即返(同一协议各行 logo 相同)。
export async function defiProtocolLogoUrl(
  userId: string,
  protocol: string,
): Promise<string | undefined> {
  const snapshots = await db.getLatestSnapshotByUser(userId);
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
      if (r.success && r.data.protocol === protocol && r.data.protocolLogo) {
        return r.data.protocolLogo;
      }
    }
  }
  return undefined;
}
