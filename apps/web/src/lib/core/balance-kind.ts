// Old snapshot rows may still carry legacy kinds (perp + meta.role, manual, utxo); unknown or
// legacy kinds fall back to spot and never throw.
export type ViewKind = "spot" | "defi" | "perp_equity" | "perp_position";

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
    case "defi":
    case "perp_equity":
    case "perp_position":
      return row.kind;
    case "perp": // legacy: single kind + meta.role
      return legacyPerpRole(row.metaJson) === "position" ? "perp_position" : "perp_equity";
    default:
      return "spot";
  }
}

// Only spot is aggregated across accounts; defi/perp render in their own sections.
export function isFungible(vk: ViewKind): boolean {
  return vk === "spot";
}
