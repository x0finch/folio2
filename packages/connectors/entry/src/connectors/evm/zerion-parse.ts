import { ConnectorUnavailableError, type Defi, type Spot } from "@folio/connectors-basic";
import { tokenRef } from "@folio/oracle-ref";
import type { ZerionPositionsResponse } from "@folio/zerion-client";

export type Row = Spot | Defi;

// Debt legs negate amount (price stays positive): revalue recomputes value as amount × price, so a
// sign carried only on value would be lost.
const DEBT_POSITION_TYPES = new Set(["loan", "borrow"]);

// `contract` (not `issued`) marks the symbol as deployer-supplied and untrusted.
function evmTokenRef(chainId: number, contract: string | undefined): string {
  const namer = `evm:${chainId}`;
  return contract ? tokenRef.contract(namer, contract) : tokenRef.native(namer);
}

// Throws rather than emitting a `chain:<slug>` fallback ref, which would split token identity.
export function parsePositions(
  res: ZerionPositionsResponse,
  chainIds: Record<string, number>,
): Row[] {
  const out: Row[] = [];
  for (const p of res.data ?? []) {
    const a = p.attributes;
    if (!a || a.flags?.displayable === false) continue;
    const symbol = a.fungible_info?.symbol;
    if (!symbol) continue;
    const chain = p.relationships?.chain?.data?.id;
    const chainId = chain ? chainIds[chain] : undefined;
    if (chainId === undefined) {
      // Retryable: the chain list is cached for 24h, so a missing chain is usually just stale.
      throw new ConnectorUnavailableError({
        message: `zerion: no chainId for chain '${chain ?? "?"}' (${symbol})`,
      });
    }
    const isDefi = a.position_type !== "wallet" || Boolean(a.protocol);
    // An implementation with a null address is the chain's native gas coin.
    const impl = a.fungible_info?.implementations?.find((i) => i.chain_id === chain);
    // No implementation on this chain → no canonical ref; skip the row.
    if (!impl) continue;
    const contract = impl.address ?? undefined;
    const debt = a.position_type != null && DEBT_POSITION_TYPES.has(a.position_type);
    const sign = debt ? -1 : 1;
    const base = {
      symbol,
      amount: sign * Math.abs(a.quantity?.float ?? 0),
      price: a.price ?? undefined,
      value: sign * Math.abs(a.value ?? 0),
      tokenRef: evmTokenRef(chainId, contract),
      name: a.fungible_info?.name,
      logo: a.fungible_info?.icon?.url,
    };
    if (isDefi) {
      out.push({
        ...base,
        kind: "defi",
        meta: { protocol: a.protocol ?? undefined, positionType: a.position_type },
      });
    } else {
      out.push({ ...base, kind: "spot" });
    }
  }
  return out;
}
