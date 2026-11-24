import type { InferSelectModel } from "drizzle-orm";
import type {
  accounts,
  portfolios,
  snapshotBalances,
  snapshots,
  tabPins,
  tags,
  userSettings,
} from "./app";

export type Account = InferSelectModel<typeof accounts>;
// Public-safe shape: never includes creds (the client gets the safeView projection).
export type AccountSafe = Omit<Account, "creds">;

export type Portfolio = InferSelectModel<typeof portfolios>;

export type Tag = InferSelectModel<typeof tags>;

export type TabPin = InferSelectModel<typeof tabPins>;

export type Snapshot = InferSelectModel<typeof snapshots>;
export type SnapshotBalance = InferSelectModel<typeof snapshotBalances>;

export type UserSettings = InferSelectModel<typeof userSettings>;
// Valuation modes (same set as @folio/oracle's ValuationMode; declared here so db doesn't depend on oracle).
export type ValuationMode = "self-first" | "source-first";
