import { ConnectorUnavailableError, type Defi, type Spot } from "@folio/connectors-basic";
import { tokenRef } from "@folio/oracle-ref";
import type { RabbyProtocol, RabbyToken } from "@folio/rabby-client";
import type { z } from "zod";
import { DUST_USD } from "./constants";

type SpotRow = z.infer<typeof Spot>;
type DefiRow = z.infer<typeof Defi>;

export type Row = SpotRow | DefiRow;

// Always yields a canonical ref or throws: a fallback ref would pollute the token index, which is
// worse than failing the sync. Native gas coins have a chain slug (e.g. "eth") as `id`, not 0x.
function refOf(token: RabbyToken, chainIds: Record<string, number>): string {
  const chain = token.chain;
  const chainId = chain ? chainIds[chain] : undefined;
  if (chainId === undefined) {
    throw new ConnectorUnavailableError({
      message: `rabby: no chainId for chain '${chain ?? "?"}' (${token.symbol ?? "?"})`,
    });
  }
  const namer = `evm:${chainId}`;
  const id = token.id ?? "";
  return id.startsWith("0x") ? tokenRef.contract(namer, id) : tokenRef.native(namer);
}

// Liabilities put the sign on amount and keep the price positive: revalue recomputes value as
// amount × price, so a sign on value alone would be lost.
function baseRow(token: RabbyToken, chainIds: Record<string, number>, sign: 1 | -1) {
  const amount = sign * Math.abs(token.amount ?? 0);
  const price = token.price ?? undefined;
  return {
    symbol: token.symbol as string,
    amount,
    price,
    // The upstream gives no usd_value; unpriced coins have price 0 → value 0 (dropped as dust).
    value: amount * (price ?? 0),
    tokenRef: refOf(token, chainIds),
    name: token.name ?? undefined,
    logo: token.logo_url ?? undefined,
  };
}

// Filters by value only. On this endpoint is_core / is_verified / is_scam flags filter nothing,
// and `credit_score` drops priced memecoins while keeping cheap junk (and may be 0 for new coins).
export function parseTokens(
  tokens: readonly RabbyToken[],
  chainIds: Record<string, number>,
): SpotRow[] {
  const out: SpotRow[] = [];
  for (const t of tokens) {
    if (!t.symbol) continue;
    if (t.is_scam || t.is_suspicious) continue;
    const row = baseRow(t, chainIds, 1);
    const isNative = !(t.id ?? "").startsWith("0x");
    if (!isNative && row.value < DUST_USD) continue;
    out.push({ ...row, kind: "spot" });
  }
  return out;
}

// Borrow legs are negated: the upstream reports them as positive amounts. Rewards stay positive.
// No dust filter: positions are already curated upstream and filtering would break the net worth.
export function parseProtocols(
  protocols: readonly RabbyProtocol[],
  chainIds: Record<string, number>,
): DefiRow[] {
  const out: DefiRow[] = [];
  for (const p of protocols) {
    const protocol = p.name ?? p.id ?? undefined;
    const protocolLogo = p.logo_url ?? undefined;
    for (const item of p.portfolio_item_list ?? []) {
      const detail = item.detail;
      if (!detail) continue;
      // Display-only keys (description / health_rate / …) don't produce rows; token lists do.
      const legs: Array<[readonly RabbyToken[], 1 | -1]> = [
        [detail.supply_token_list ?? [], 1],
        [detail.reward_token_list ?? [], 1],
        [detail.token ? [detail.token] : [], 1], // singular shape (e.g. Vesting)
        [detail.borrow_token_list ?? [], -1],
      ];
      for (const [tokens, sign] of legs) {
        for (const t of tokens) {
          if (!t.symbol) continue;
          out.push({
            ...baseRow(t, chainIds, sign),
            kind: "defi",
            meta: { protocol, positionType: item.name ?? undefined, protocolLogo },
          });
        }
      }
    }
  }
  return out;
}
