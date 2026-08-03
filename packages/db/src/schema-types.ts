import type { InferSelectModel } from "drizzle-orm";
import type { accounts, snapshotBalances, snapshots, userSettings } from "./schema";

export type Account = InferSelectModel<typeof accounts>;
// 对外安全形状:绝不含 creds(内含 secret 密文 + 不裸给前端;前端拿的是 safeView 投影)。
export type AccountSafe = Omit<Account, "creds">;

export type Snapshot = InferSelectModel<typeof snapshots>;
export type SnapshotBalance = InferSelectModel<typeof snapshotBalances>;

export type UserSettings = InferSelectModel<typeof userSettings>;
// 估值模式(与 @folio/oracle 的 ValuationMode 同集合;db 层不耦合 oracle,就地声明)。
export type ValuationMode = "self-first" | "source-first";
