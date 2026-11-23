import type { CoinstatsCoin } from "@folio/coinstats-client";
import type { Spot } from "@folio/connectors-basic";
import { tokenRef } from "@folio/oracle-ref";

// Serves solana / sui / cosmos; only `connectionId` differs.
function chainTokenRef(chain: string, contract: string | undefined): string {
  return contract ? tokenRef.contract(chain, contract) : tokenRef.native(chain);
}

export type Row = Spot;

export function parseBalances(coins: readonly CoinstatsCoin[], fallbackChain: string): Row[] {
  const out: Row[] = [];
  for (const c of coins ?? []) {
    const symbol = c.symbol?.trim();
    if (!symbol) continue;
    const amount = c.amount ?? 0;
    const chain = c.chain?.trim() || fallbackChain;
    out.push({
      symbol,
      amount,
      price: c.price ?? undefined,
      value: amount * (c.price ?? 0),
      kind: "spot",
      // Addresses keep their case (base58 / bech32 are case-sensitive); oracle-ref normalises per chain.
      tokenRef: chainTokenRef(chain, c.contractAddress ?? undefined),
      name: c.name,
    });
  }
  return out;
}
