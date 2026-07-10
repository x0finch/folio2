// 读端 kind 归一(ADR 0010,并存期)。kind 收敛为 4 个粗粒度资产类别。快照行的 kind 可能是:
//   · 当前 4-kind:spot / defi / perp_equity / perp_position
//   · 或旧快照的遗留 kind:perp(靠 meta.role 拆 equity/position)/ manual / utxo / 骑 spot 的 bitcoin
// 本助手把两者归到统一 ViewKind,读端只认 4-kind。**未知/遗留 kind 兜底 spot、绝不 throw**
//(并存期:老快照里的旧 kind 字符串全靠此吃下 —— utxo/manual/bitcoin 一律归 spot,BTC 展示细节
// 改由 detail 块承载,老快照下次同步后 blockbook 写 detail[] 自愈)。
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
  metaJson?: string | null;
}

export function viewKind(row: KindRow): ViewKind {
  switch (row.kind) {
    case "spot":
    case "defi":
    case "perp_equity":
    case "perp_position":
      return row.kind;
    case "perp": // 遗留:单 kind + meta.role
      return legacyPerpRole(row.metaJson) === "position" ? "perp_position" : "perp_equity";
    default:
      // 未知/遗留(含老快照的 utxo / manual / 骑 spot 的 bitcoin)→ 当现货兜底,不 throw
      return "spot";
  }
}

// 进"首屏跨账户聚合"的同质现货口径:现货(含并回 spot 的 BTC)。defi/perp 不进聚合(走次级分区)。
export function isFungible(vk: ViewKind): boolean {
  return vk === "spot";
}
