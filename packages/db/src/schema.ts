import type { ConnectorId } from "@folio/connectors";
import type { BalanceKind } from "@folio/connectors-basic";
import {
  index,
  integer,
  primaryKey,
  real,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";
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

// 业务账户:被追踪的余额来源(钱包 / CEX / 永续 / manual),由 connectorId 决定派哪个 connector/provider。
// ⚠️ 勿与 auth-schema.ts 的 `account`(better-auth 的登录方式链接表)混淆——只是单复数相近,
//    语义完全不同:这张是「资产账户」,那张是「认证」。
export const accounts = sqliteTable(
  "accounts",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    connectorId: text("connector_id").$type<ConnectorId>().notNull(),
    network: text("network"),
    label: text("label").notNull(),
    // 凭据 map(JSON,db 当作不透明 blob、不解释内容):按字段 type 存——secret 字段值为 AES-GCM 密文,
    // public/semi 明文;导入待补录的 semi 以 `semi_<key>` 占位记录打码片段(见 app lib/creds.ts / P6.6.1)。
    // 缺凭据态由 `isComplete(provider.inputs, creds)` 在内存判定,不再用列是否为 null。
    // 物理列名沿用历史的 `enc_credentials`(P1.4 起,避免一次纯改名迁移);字段名 creds 才是当前语义。
    // P6.6.2:manual 持仓也并入 creds(symbol/amount/usdValue 三个 public 输入),原 data_json 列已删。
    creds: text("enc_credentials"),
    createdAt: integer("created_at").notNull(), // epoch ms
    // 归档:非 null = 已归档(值为归档时刻 epoch ms)。归档账户不计总额、不参与同步、数据保留、可逆。
    archivedAt: integer("archived_at"), // epoch ms | null(默认 null = 活跃)
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
    // CAIP-19 代币标识(provider 构造;可空:CEX/manual/原生缺失)。读取时富化/解析的 tokenKey。
    tokenKey: text("token_key"),
    metaJson: text("meta_json"), // JSON.stringify(meta),可空
  },
  (t) => [index("snapshot_balances_snapshot_id_idx").on(t.snapshotId)],
);

// —— 代币参考层(canonical-token-aggregation P1)——
// 全局参考数据,**无 userId**(原则 #6 受控例外,同 listUserIdsWithAccounts)。
// 代币表 = 系统认识的每个代币一行(CGK 收录币或 provider 孤儿);索引表 = 纯指针(symbol 候选 / tokenKey)。
// 经 @folio/db 的 createTokenStore(env,{source}) 访问;key 归一由 @folio/tokens 调用方保证。

// 展示分组(P2,ADR-0001):用户心智里的"一个币"的家族,可跨多个 Token(CGK 故意拆开的桥接变体)。
// 产品自有种子(GROUP_MEMBERSHIP)驱动,不用 CGK coin id 当跨链身份;无组的 Token = 自身单例组。
export const tokenGroups = sqliteTable("token_groups", {
  id: text("id").primaryKey(), // UUID
  displaySymbol: text("display_symbol").notNull(), // 展示 symbol(大写归一)
  name: text("name").notNull(),
  logo: text("logo"), // 可空:默认取主成员
});

// 代币表:info facet(name/logo,长 TTL)+ price facet(短 TTL;过期=stale 不删,SWR)合一行。
// cgk 行:source="coingecko"、identifier=CGK coin id;孤儿行:source="provider"、identifier=tokenKey 键。
export const tokens = sqliteTable(
  "tokens",
  {
    id: text("id").primaryKey(), // UUID
    source: text("source").notNull(),
    identifier: text("identifier").notNull(),
    symbol: text("symbol").notNull(), // 归一(大写)
    name: text("name").notNull(),
    logo: text("logo"), // canonical(CGK);孤儿行 NULL
    providerLogo: text("provider_logo"), // 备用槽:provider 自带图(孤儿主图;cgk 缺图兜底)
    marketCapRank: integer("market_cap_rank"),
    // 展示分组(P2):命中种子成员的 cgk 行落库时回填;孤儿/未收录 = NULL(单例组)。组删除则置空。
    groupId: text("group_id").references(() => tokenGroups.id, { onDelete: "set null" }),
    infoExpiresAt: integer("info_expires_at").notNull(), // name/logo 长 TTL
    unitPrice: real("unit_price"), // 价 facet(可空 = 尚无价)
    change24h: real("change_24h"),
    priceAsOf: integer("price_as_of"),
    priceExpiresAt: integer("price_expires_at"), // 短 TTL;过期读出带 stale
  },
  (t) => [uniqueIndex("tokens_source_identifier_idx").on(t.source, t.identifier)],
);

// 索引表:多种方式找到代币,纯指针不存代币数据。
// kind="symbol":一 symbol 多候选(消歧输入),随 warm 换血(短 TTL);
// kind="tokenKey":代币键(eip155:<id>/erc20:<addr> 等)一对一(代码维护唯一),长 TTL(sync 顺延);
// cgk_checked_until(仅 tokenKey):问过 CGK"未收录"的复查时刻(替代旧否定缓存三态)。
export const tokenIndex = sqliteTable(
  "token_index",
  {
    kind: text("kind").$type<"symbol" | "tokenKey">().notNull(),
    key: text("key").notNull(),
    tokenId: text("token_id")
      .notNull()
      .references(() => tokens.id, { onDelete: "cascade" }),
    cgkCheckedUntil: integer("cgk_checked_until"),
    expiresAt: integer("expires_at").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.kind, t.key, t.tokenId] }),
    index("token_index_kind_key_idx").on(t.kind, t.key),
  ],
);

// 杂项标量:存 `warm_as_of:<source>`(每源 warm 最近刷新时刻)。
export const tokenMeta = sqliteTable("token_meta", {
  k: text("k").primaryKey(),
  v: integer("v").notNull(),
});

// 平台元数据缓存(链 ∪ 交易所/perp 的 name+logo,来自 CoinGecko;近静态,长 TTL)。
// id = platformKey(eip155:<id> / chain:<slug> / exchange:<slug> / perp:<slug>)。
// name IS NULL = 否定缓存(问过 CoinGecko、确认不存在);无该行 = 从未取过。
export const platforms = sqliteTable("platforms", {
  id: text("id").primaryKey(),
  name: text("name"),
  logo: text("logo"),
  expiresAt: integer("expires_at").notNull(),
});

// FX 汇率缓存(全局参考,无 userId)。usd_per_unit = 1 单位该币种的美元价。
// expires_at 只闸 warm;读软过期(见 @folio/fx / ADR 0006)。
export const fxRates = sqliteTable("fx_rates", {
  currency: text("currency").primaryKey(),
  usdPerUnit: real("usd_per_unit").notNull(),
  expiresAt: integer("expires_at").notNull(),
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
