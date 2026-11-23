import type { DbRequest, SnapshotWithBalances } from "@folio/db";
import { Oracle } from "@folio/oracle";
import { fiatCodeOf, type TokenRecord } from "@folio/oracle-basic";
import { Effect, Option } from "effect";
import type { CredsToken } from "@/lib/core/manual";
import { MANUAL_CONNECTOR_ID } from "@/lib/core/manual";

// Display unit price (USD) per manual token, aligned with `tokens`. Fiat is identified by tokenId
// via `fiatRefs` — not `CredsToken.ref`, which is null for fiat — and priced at the live fx rate.
// Others use the cache-only enriched price. Missing → `undefined`, and the snapshot falls back.
export const manualUnitPrices = (
  tokens: readonly CredsToken[],
  enriched: ReadonlyMap<string, TokenRecord>,
  fiatRefs: ReadonlyMap<string, string>,
): Effect.Effect<(number | undefined)[], never, Oracle | DbRequest> =>
  Effect.gen(function* () {
    const { fx } = yield* Oracle;
    const codeOf = (t: CredsToken): string | undefined => {
      const fiatRef = fiatRefs.get(t.id);
      return fiatRef ? fiatCodeOf(fiatRef) : undefined;
    };

    const rates = new Map<string, number>();
    for (const code of new Set(tokens.flatMap((t) => (codeOf(t) ? [codeOf(t) as string] : [])))) {
      const rate = yield* fx.resolve(code);
      if (Option.isSome(rate)) rates.set(code, rate.value);
    }

    return tokens.map((t) => {
      const code = codeOf(t);
      return code ? rates.get(code) : enriched.get(t.id)?.price?.unitPrice;
    });
  });

// Manual accounts never write snapshots; their current holdings are synthesised at read time from
// creds.tokens. Live price × amount when known, else the fallback price. `takenAt` and ids are
// placeholders.
export function buildManualSnapshot(
  accountId: string,
  tokens: CredsToken[],
  prices: (number | undefined)[],
  takenAt: number,
): SnapshotWithBalances {
  const balances = tokens.map((t, i) => {
    const price = prices[i] ?? t.fallbackPrice ?? 0;
    return {
      id: `manual:${accountId}:${i}`,
      snapshotId: `manual:${accountId}`,
      amount: t.amount,
      usdValue: t.amount * price,
      kind: "spot" as const,
      platform: MANUAL_CONNECTOR_ID,
      selfPrice: null,
      // Required: enrichment, warming and price refresh all key on `tokenId`; without it the token
      // gets no name, logo or price.
      tokenId: t.id,
      metaJson: null,
    };
  });
  const totalUsd = balances.reduce((sum, b) => sum + b.usdValue, 0);
  return {
    snapshot: { id: `manual:${accountId}`, accountId, takenAt, totalUsd, note: null },
    balances,
  };
}
