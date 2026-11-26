import { z } from "zod";
import type { Holding } from "@/lib/core/portfolio";

// Slices holdings into pie slices; all dimensions derive from holdings/sources so totals agree.
// The tail beyond topN collapses into one OTHERS_KEY slice.
const ALLOC_DIMENSION = z.enum(["token", "chain", "account"]);
export type AllocDimension = z.infer<typeof ALLOC_DIMENSION>;
export const ALLOC_DIMENSIONS = ALLOC_DIMENSION.options;
export const DEFAULT_DIM: AllocDimension = "token";
export interface AllocSlice {
  key: string;
  label: string;
  value: number;
}
export const OTHERS_KEY = "__others__";
// One slice per palette colour: four named slices and the tail, so no colour repeats and slivers
// too thin for the ring don't pile up.
const NAMED_SLICES = 4;

export function buildAllocation(
  holdings: readonly Holding[],
  dim: AllocDimension,
  topN = NAMED_SLICES,
): AllocSlice[] {
  const map = new Map<string, { label: string; value: number }>();
  const add = (key: string, label: string, value: number) => {
    const e = map.get(key);
    if (e) e.value += value;
    else map.set(key, { label, value });
  };
  for (const h of holdings) {
    if (dim === "token") {
      add(h.key, h.token.symbol, h.totalValue);
    } else {
      for (const s of h.sources) {
        if (dim === "chain") add(s.platform.id, s.platform.name, s.value);
        else add(s.account.id, s.account.label, s.value);
      }
    }
  }
  const slices = [...map.entries()]
    .map(([key, v]) => ({ key, label: v.label, value: v.value }))
    .filter((s) => s.value > 0)
    .sort((a, b) => b.value - a.value);
  if (slices.length <= topN) return slices;
  const top = slices.slice(0, topN);
  const othersValue = slices.slice(topN).reduce((s, x) => s + x.value, 0);
  top.push({ key: OTHERS_KEY, label: OTHERS_KEY, value: othersValue });
  return top;
}
