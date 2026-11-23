// Valuation priority pure function: the only place deciding whose price to listen to. selfPrice = the balance provider's own unit
// price; sourcePrice = the active market source's. self-first (default): own if present else source; source-first (user switch):
// source if present else own. Neither gives undefined (the caller keeps the original value, no zeroing). Pure, no IO.
// Lives in basic (not entry) because it is client-safe and the read path uses it in the client bundle.
export type ValuationMode = "self-first" | "source-first";

export function valuate(
  amount: number,
  selfPrice: number | undefined,
  sourcePrice: number | undefined,
  mode: ValuationMode,
): { unitPrice: number; value: number } | undefined {
  const [primary, fallback] =
    mode === "source-first" ? [sourcePrice, selfPrice] : [selfPrice, sourcePrice];
  const unit = primary ?? fallback;
  if (unit == null) return undefined;
  return { unitPrice: unit, value: amount * unit };
}
