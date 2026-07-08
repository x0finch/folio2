// 读端 kind 归一(ADR 0009 并存期)。快照行的 kind 可能是:
//   · 迁移后的新 5-kind:spot / defi / perp_equity / perp_position / utxo
//   · 或旧 provider 写的遗留 kind:spot / defi / perp(靠 meta.role)/ manual / 骑 spot 的 bitcoin
// 本助手把两者归到统一 ViewKind,读端只认 5-kind。**未知 kind 兜底 spot、绝不 throw**
//(#30 并存期:旧 provider 输出即"遗留 kind",全靠此吃下)。
export type ViewKind = "spot" | "defi" | "perp_equity" | "perp_position" | "utxo";

// 从遗留 perp 行的 metaJson 读 role(仅判 equity/position);读不到当 equity。
function legacyPerpRole(metaJson: string | null | undefined): "equity" | "position" {
  if (!metaJson) return "equity";
  try {
    const r = (JSON.parse(metaJson) as { role?: unknown }).role;
    return r === "position" ? "position" : "equity";
  } catch {
    return "equity";
  }
}

export interface KindRow {
  kind: string;
  tokenKey?: string | null;
  metaJson?: string | null;
}

export function viewKind(row: KindRow): ViewKind {
  switch (row.kind) {
    case "spot":
      // 遗留:BTC 骑在 spot 上、靠 tokenKey 认出 → 归 utxo。
      return row.tokenKey?.startsWith("chain:bitcoin") ? "utxo" : "spot";
    case "manual": // 遗留:来源不是契约 → 现货
      return "spot";
    case "defi":
    case "perp_equity":
    case "perp_position":
    case "utxo":
      return row.kind;
    case "perp": // 遗留:单 kind + meta.role
      return legacyPerpRole(row.metaJson) === "position" ? "perp_position" : "perp_equity";
    default:
      return "spot"; // 未知/遗留 → 当现货兜底,不 throw
  }
}

// 进"首屏跨账户聚合"的同质现货口径:现货 + UTXO(BTC)。defi/perp 不进聚合(走次级分区)。
export function isFungible(vk: ViewKind): boolean {
  return vk === "spot" || vk === "utxo";
}
