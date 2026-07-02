import type { AccountType, BalanceKind } from "@folio/core";
import { index, integer, primaryKey, real, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { user } from "./auth-schema";

// 身份表(user/session/account/verification)定义在 ./auth-schema(better-auth,P2.1)。
// 此处再导出,让 drizzle-kit 把它们一并纳入迁移。业务表的 userId 为指向 user.id 的真外键。
export * from "./auth-schema";

export const groups = sqliteTable(
  "groups",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    sortOrder: integer("sort_order").notNull().default(0),
  },
  (t) => [index("groups_user_id_idx").on(t.userId)],
);

// 业务账户:被追踪的余额来源(钱包 / CEX / 永续 / manual),由 type 决定派哪个 provider。
// ⚠️ 勿与 auth-schema.ts 的 `account`(better-auth 的登录方式链接表)混淆——只是单复数相近,
//    语义完全不同:这张是「资产账户」,那张是「认证」。
export const accounts = sqliteTable(
  "accounts",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    type: text("type").$type<AccountType>().notNull(),
    network: text("network"),
    label: text("label").notNull(),
    // 凭据 map(JSON,db 当作不透明 blob、不解释内容):按字段 type 存——secret 字段值为 AES-GCM 密文,
    // public/semi 明文;导入待补录的 semi 以 `semi_<key>` 占位记录打码片段(见 @folio/core creds.ts / P6.6.1)。
    // 缺凭据态由 `isComplete(provider.inputs, creds)` 在内存判定,不再用列是否为 null。
    // 物理列名沿用历史的 `enc_credentials`(P1.4 起,避免一次纯改名迁移);字段名 creds 才是当前语义。
    // P6.6.2:manual 持仓也并入 creds(symbol/amount/usdValue 三个 public 输入),原 data_json 列已删。
    creds: text("enc_credentials"),
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
  (t) => [
    index("snapshots_account_id_idx").on(t.accountId),
    // greatest-n-per-group:取每账户最新快照(getLatestSnapshotByUser)走这条复合索引。
    index("snapshots_account_id_taken_at_idx").on(t.accountId, t.takenAt),
  ],
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

// —— 代币参考缓存(P7.3.1)——
// 全局参考数据,**无 userId**(原则 #6 受控例外,同 listUserIdsWithAccounts);按 `source` 维度分桶
// (CGK / 将来 CMC 各自全局成立、共存)。各表 `expires_at`(epoch ms)做 TTL:读时按 > now 过滤,过期当未命中。
// 经 @folio/db 的 createTokenStore(env,{source}) 访问;db 把内容当不透明数据,不解释。

// warm:top-N markets 的 symbol→候选(带市值排名)。一 symbol 可多候选。
export const tokenWarm = sqliteTable(
  "token_warm",
  {
    symbol: text("symbol").notNull(), // 归一(大写)key —— 由 @folio/tokens 调用方保证,store 不再自己归一
    source: text("source").notNull(),
    coinId: text("coin_id").notNull(),
    marketCapRank: integer("market_cap_rank"),
    expiresAt: integer("expires_at").notNull(),
  },
  (t) => [primaryKey({ columns: [t.symbol, t.source, t.coinId] })],
);

// 元信息 facet(name/symbol/logo),按 (source, coinId) 键。
export const tokenInfo = sqliteTable(
  "token_info",
  {
    source: text("source").notNull(),
    coinId: text("coin_id").notNull(),
    symbol: text("symbol").notNull(),
    name: text("name").notNull(),
    logo: text("logo"),
    expiresAt: integer("expires_at").notNull(),
  },
  (t) => [primaryKey({ columns: [t.source, t.coinId] })],
);

// 价 facet(USD,无 vs 列),按 (source, coinId) 键。
export const tokenPrice = sqliteTable(
  "token_price",
  {
    source: text("source").notNull(),
    coinId: text("coin_id").notNull(),
    unitPrice: real("unit_price").notNull(),
    change24h: real("change_24h"),
    marketCapRank: integer("market_cap_rank"),
    asOf: integer("as_of").notNull(),
    expiresAt: integer("expires_at").notNull(),
  },
  (t) => [primaryKey({ columns: [t.source, t.coinId] })],
);

// 合约懒解析缓存,按 (source, chain, contract) 键。coin_id 为 NULL = 该 source 的否定缓存(已知缺失);
// 无行(或过期)= 未知(去取)。chain/contract 小写归一。
export const tokenContract = sqliteTable(
  "token_contract",
  {
    source: text("source").notNull(),
    chain: text("chain").notNull(),
    contract: text("contract").notNull(),
    coinId: text("coin_id"),
    expiresAt: integer("expires_at").notNull(),
  },
  (t) => [primaryKey({ columns: [t.source, t.chain, t.contract] })],
);

// 杂项标量:存 `warm_as_of:<source>`(每源 warm 最近刷新时刻)。
export const tokenMeta = sqliteTable("token_meta", {
  k: text("k").primaryKey(),
  v: integer("v").notNull(),
});

// manual 活动账本(P7.4.1):add/reduce/set 动作日志。当前数量由 deriveAmount 推导、物化进 account.creds.amount
// (provider/sync 不依赖本表)。price 记录单价、留给 M7.3 成本/盈亏,本期不算。与 M7.2 的通用 transactions 表分开。
export const manualActivity = sqliteTable(
  "manual_activity",
  {
    id: text("id").primaryKey(),
    accountId: text("account_id")
      .notNull()
      .references(() => accounts.id, { onDelete: "cascade" }),
    kind: text("kind").$type<"add" | "reduce" | "set">().notNull(),
    amount: real("amount").notNull(),
    price: real("price"), // 单价(可空),留 M7.3
    occurredAt: integer("occurred_at").notNull(), // epoch ms
    note: text("note"),
    createdAt: integer("created_at").notNull(),
  },
  (t) => [index("manual_activity_account_id_occurred_at_idx").on(t.accountId, t.occurredAt)],
);
