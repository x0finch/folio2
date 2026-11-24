import type { Balance, Note } from "@folio/connectors-basic";

export type FetchOutcome =
  | { status: "ok"; balances: Balance[]; totalUsd: number; note?: Note[] }
  | { status: "needs-credentials" };

export type OkOutcome = Extract<FetchOutcome, { status: "ok" }>;

export interface SyncLogger {
  debug(message: string, properties?: Record<string, unknown>): void;
  info(message: string, properties?: Record<string, unknown>): void;
  warning(message: string, properties?: Record<string, unknown>): void;
  error(message: string, properties?: Record<string, unknown>): void;
}

/** `manual`: no upstream, nothing for the user to do; `missing-credentials`: the user should finish entering them. */
export type SyncSkipReason = "manual" | "missing-credentials";

export interface AccountSyncResult {
  accountId: string;
  ok: boolean;
  skipped?: boolean; // skipped, not a failure
  skipReason?: SyncSkipReason;
  snapshotId?: string;
  totalUsd?: number;
  error?: string;
}

export interface SyncResult {
  results: AccountSyncResult[];
}
