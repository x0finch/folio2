import type { ConnectorId } from "@folio/connectors";
import type { AccountSafe } from "@folio/db";
import { createManualAccount } from "@/lib/server/manual/store";
import { db } from "./db";
import { call } from "./run";

export const seedAccount = (
  userId: string,
  label: string,
  connectorId: ConnectorId = "manual",
): Promise<AccountSafe> => db(userId).accounts.create({ connectorId, label, creds: null });

export interface BalanceSpec {
  readonly tokenId: string;
  readonly amount: number;
  readonly usdValue: number;
  readonly kind?: "spot" | "defi" | "perp_equity" | "perp_position";
  readonly platform?: string;
  readonly selfPrice?: number;
  readonly meta?: Record<string, unknown>;
}

/**
 * `takenAt` is required: most cases hinge on relative times. `totalUsd` defaults to the sum of
 * balances but is overridable to test a total/detail mismatch.
 */
export const seedSnapshot = (
  userId: string,
  accountId: string,
  takenAt: number,
  balances: readonly BalanceSpec[],
  totalUsd?: number,
): Promise<string> =>
  db(userId).snapshots.write(accountId, {
    takenAt,
    totalUsd: totalUsd ?? balances.reduce((sum, b) => sum + b.usdValue, 0),
    balances: balances.map((b) => ({
      amount: b.amount,
      usdValue: b.usdValue,
      kind: b.kind ?? "spot",
      tokenId: b.tokenId,
      platform: b.platform,
      selfPrice: b.selfPrice,
      meta: b.meta,
    })),
  });

export const DAY = 86_400_000;
export const HOUR = 3_600_000;

/** Manual account + first token + opening entry, via the production `createManualAccount`. */
export const seedManualAccount = (
  userId: string,
  label: string,
  token: { symbol: string; unitPrice: number; amount: number },
): Promise<AccountSafe> =>
  call(
    userId,
    createManualAccount(
      label,
      JSON.stringify([{ symbol: token.symbol, unitPrice: token.unitPrice, amount: token.amount }]),
    ),
  );
