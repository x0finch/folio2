// 读端 kind 归一(ADR 0009 并存期)。快照行的 kind 可能是:
//   · 新 4-kind:spot / defi / perp_equity / perp_position(ADR 0010:utxo 已并回 spot,BTC 吐 spot)
//   · 或旧 provider 写的遗留 kind:spot / defi / perp(靠 meta.role)/ manual / utxo(旧 BTC)
// 本助手把两者归到统一 ViewKind,读端只认 4-kind。**未知/遗留 kind(含旧 utxo)兜底 spot、绝不 throw**
//(#30 并存期 + ADR 0010 老化:旧 utxo 快照行经 default 归 spot,主表数量/金额/聚合不变)。
export type ViewKind = "spot" | "defi" | "perp_equity" | "perp_position";

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
    case "defi":
    case "perp_equity":
    case "perp_position":
      return row.kind;
    case "perp": // 遗留:单 kind + meta.role
      return legacyPerpRole(row.metaJson) === "position" ? "perp_position" : "perp_equity";
    default:
      // spot / manual(遗留)/ utxo(遗留)/ 骑 spot 的 BTC / 未知 → 一律现货兜底,不 throw。
      return "spot";
  }
}

// 进"首屏跨账户聚合"的同质现货口径:现货(含并回的 BTC)。defi/perp 不进聚合(走次级分区)。
export function isFungible(vk: ViewKind): boolean {
  return vk === "spot";
}
