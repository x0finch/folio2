import type { InferInsertModel, InferSelectModel } from "drizzle-orm";
import type { accountGroups, accounts, groups, snapshotBalances, snapshots } from "./schema";

export type Account = InferSelectModel<typeof accounts>;
export type NewAccount = InferInsertModel<typeof accounts>;
// 对外安全形状:绝不含密文 encCredentials。
export type AccountSafe = Omit<Account, "encCredentials">;

export type Group = InferSelectModel<typeof groups>;
export type NewGroup = InferInsertModel<typeof groups>;

export type AccountGroup = InferSelectModel<typeof accountGroups>;

export type Snapshot = InferSelectModel<typeof snapshots>;
export type SnapshotBalance = InferSelectModel<typeof snapshotBalances>;
