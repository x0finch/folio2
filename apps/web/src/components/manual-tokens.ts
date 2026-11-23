// Separate file so its unit test doesn't pull account-fields.tsx's server-only imports.
export function manualTokensJson(fields: {
  symbol: string;
  unitPrice: string;
  amount: string;
  ticket?: string;
}): string {
  const entry: Record<string, string> = {
    symbol: fields.symbol,
    unitPrice: fields.unitPrice,
    amount: fields.amount,
  };
  if (fields.ticket) entry.ticket = fields.ticket;
  return JSON.stringify([entry]);
}
