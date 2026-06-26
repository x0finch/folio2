import type { AccountType, BalanceKind } from "@folio/core";
import { index, integer, primaryKey, real, sqliteTable, text } from "drizzle-orm/sqlite-core";

// 注:用户/会话表(user/session/...)由 better-auth 在 P2.1 生成并管理,不在此手写。
// 业务表的 userId 暂存为 text(P2.1 再加指向 user.id 的外键);业务表之间的外键此处即启用。

export const groups = sqliteTable(
  "groups",
  {
    id: text("id").primaryKey(),
    userId: text("user_id").notNull(),
    name: text("name").notNull(),
    sortOrder: integer("sort_order").notNull().default(0),
  },
  (t) => [index("groups_user_id_idx").on(t.userId)],
);

export const accounts = sqliteTable(
  "accounts",
  {
    id: text("id").primaryKey(),
    userId: text("user_id").notNull(),
    type: text("type").$type<AccountType>().notNull(),
    network: text("network"),
    label: text("label").notNull(),
    encCredentials: text("enc_credentials").notNull(), // AES-GCM 密文 blob,db 不解释内容
    createdAt: integer("created_at").notNull(), // epoch ms
  },
  (t) => [index("accounts_user_id_idx").on(t.userId)],
);

export const accountGroups = sqliteTable(
  "account_groups",
  {
    accountId: text("account_id")
      .notNull()
      .references(() => accounts.id, { onDelete: "cascade" }),
    groupId: text("group_id")
      .notNull()
      .references(() => groups.id, { onDelete: "cascade" }),
  },
  (t) => [
    primaryKey({ columns: [t.accountId, t.groupId] }),
    index("account_groups_group_id_idx").on(t.groupId),
  ],
);

export const snapshots = sqliteTable(
  "snapshots",
  {
    id: text("id").primaryKey(),
    accountId: text("account_id")
      .notNull()
      .references(() => accounts.id, { onDelete: "cascade" }),
    takenAt: integer("taken_at").notNull(), // epoch ms
    totalUsd: real("total_usd").notNull(),
  },
  (t) => [index("snapshots_account_id_idx").on(t.accountId)],
);

export const snapshotBalances = sqliteTable(
  "snapshot_balances",
  {
    id: text("id").primaryKey(),
    snapshotId: text("snapshot_id")
      .notNull()
      .references(() => snapshots.id, { onDelete: "cascade" }),
    symbol: text("symbol").notNull(),
    amount: real("amount").notNull(),
    usdValue: real("usd_value").notNull(),
    kind: text("kind").$type<BalanceKind>().notNull(),
    source: text("source").notNull(),
    metaJson: text("meta_json"), // JSON.stringify(meta),可空
  },
  (t) => [index("snapshot_balances_snapshot_id_idx").on(t.snapshotId)],
);
