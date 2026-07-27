import type { ConnectorId } from "@folio/connectors";
import type { BalanceKind } from "@folio/connectors-basic";
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
    // account 级展示 note(note 重设计):JSON.stringify(Note[]),可空。整钱包一份(BTC 未确认/收款/派生分布);
    // 读时 safeParse 回 Note[](见 getLatestSnapshotByUser)。纯展示,无共享逻辑读它。
    note: text("note"),
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
    // provider 自带单价(oracle 多源 Phase 3):估值「原料」,冻结。usd_value 是成品(revalue 按当时 mode 算);
    // 当前视图从「amount + self_price + 实时源价 + 当前 mode」现推 → 切源/切开关可逆、自带价不丢。
    selfPrice: real("self_price"),
    // CAIP-19 代币标识(provider 构造;可空:CEX/manual/原生缺失)。读取时富化/解析的 tokenRef。
    tokenRef: text("token_ref"),
    // 这笔持仓所在的链 ∪ 场馆(Platform),由 provider 随 Balance 直接报(ADR 0021 / #193)。
    // 可空:本列之前写下的行没有值 —— 读端退回账户的 connectorId,下次同步即补上。
    platform: text("platform"),
    // 认定冻进快照(ADR 0021 / #199 expand):写快照前经 mint 换出的代币行 id。
    // expand 期可空(旧行没有值),#202 改必填并删掉 symbol / token_ref 两列。
    //
    // **刻意不加外键。** 两个理由:① `TokenStore.merge` 删旧代币行前会把历史行一并改指,
    // 有约束反而让「删用户」这类级联的执行顺序变成雷 —— tokens 经 user_id 级联删、
    // snapshot_balances 经 snapshots 级联删,两条独立分支的先后 SQLite 不保证,
    // 先删 tokens 就撞约束(packages/db 的测试 teardown 正是直接删 user);
    // ② 快照是不可变的历史事实,代币表是可变的参考层,让前者的存在挡住后者的维护是反的。
    // 代价是 merge 漏改指会留下悬空 id → 由 token-store 的 merge 测试盯住。
    tokenId: text("token_id"),
    metaJson: text("meta_json"), // JSON.stringify(meta),可空
    // balance 级展示 note(note 重设计):JSON.stringify(单个 Note),可空。
    // provider 挂在该 balance 上的 note 落这里;读时 safeParse 回 Note(见 getLatestSnapshotByUser)。
    note: text("note"),
  },
  (t) => [index("snapshot_balances_snapshot_id_idx").on(t.snapshotId)],
);

// —— 代币参考层(canonical-token-aggregation P1)——
// 全局参考数据,**无 userId**(原则 #6 受控例外,同 listUserIdsWithAccounts)。
// 代币表 = 系统认识的每个代币一行(CGK 收录币或 provider 孤儿);索引表 = 纯指针(symbol 候选 / tokenRef)。
// 经 @folio/db 的 createTokenStore(env,{source}) 访问;key 归一由 @folio/oracle-basic 调用方保证。

// 代币表:info facet(name/logo,长 TTL)+ price facet(短 TTL;过期=stale 不删,SWR)合一行。
// 归并身份 = tokens.id(UUID,vendor 中立,#73)。各家 vendor 的 coin id 存 token_vendor_ids 子表。
// cgk 行:有一条 token_vendor_ids(vendor="coingecko");孤儿行(CGK 未收录、provider 采集)= 无 vendor 行,
// 其 tokenRef 关联存 token_index(kind="tokenRef")。
export const tokens = sqliteTable("tokens", {
  id: text("id").primaryKey(), // UUID
  // 归属用户(ADR 0021 / #199 expand):代币表转 per-user —— 「他认识哪些币、他的币叫什么名」
  // 是用户私有数据。expand 期可空(旧的全局行没有值),#202 改必填。
  userId: text("user_id").references(() => user.id, { onDelete: "cascade" }),
  symbol: text("symbol").notNull(), // 归一(大写)
  name: text("name").notNull(),
  logo: text("logo"), // canonical(CGK);孤儿行 NULL
  providerLogo: text("provider_logo"), // 备用槽:provider 自带图(孤儿主图;cgk 缺图兜底)
  marketCapRank: integer("market_cap_rank"),
  infoExpiresAt: integer("info_expires_at").notNull(), // name/logo 长 TTL
  unitPrice: real("unit_price"), // 价 facet(可空 = 尚无价)
  change24h: real("change_24h"),
  priceAsOf: integer("price_as_of"),
  priceExpiresAt: integer("price_expires_at"), // 短 TTL;过期读出带 stale
});

// 代币的 vendor 映射(oracle 多源,#73)。一行 = 「哪个 token × 哪家 vendor × 那家的 coin id」。
// 归并靠 tokens.id;各家 coin id 是本表的属性,接新源只加行、不改表结构。(vendor, vendorId) 唯一
// (一家的一个 coin id 只对应一个 token);按 tokenId 反查建二级索引。
export const tokenVendorIds = sqliteTable(
  "token_vendor_ids",
  {
    tokenId: text("token_id")
      .notNull()
      .references(() => tokens.id, { onDelete: "cascade" }),
    vendor: text("vendor").notNull(), // 如 "coingecko"
    vendorId: text("vendor_id").notNull(), // 那家对该币的 id
  },
  (t) => [
    primaryKey({ columns: [t.vendor, t.vendorId] }),
    index("token_vendor_ids_token_idx").on(t.tokenId),
  ],
);

// 索引表:多种方式找到代币,纯指针不存代币数据。
// kind="symbol":一 symbol 多候选(消歧输入),随 warm 换血(短 TTL);
// kind="tokenRef":代币键(evm:<id>/<addr> 等)一对一(代码维护唯一),长 TTL(sync 顺延);
// cgk_checked_until(仅 tokenRef):问过 CGK"未收录"的复查时刻(替代旧否定缓存三态)。
export const tokenIndex = sqliteTable(
  "token_index",
  {
    kind: text("kind").$type<"symbol" | "tokenRef">().notNull(),
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
// id = platformKey(evm:<id> / <slug> / exchange:<slug> / perp:<slug>)。
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

// 历史日价缓存(全局参考,无 userId;#148 / ADR 0019 网格估值骨架)。过去某 UTC 日的历史价不可变 →
// 永久缓存,故**无 TTL 列**(今日桶可变,调用方不落此表)。PK (source, identifier, day_bucket);
// (source, identifier) = tokenRef 拆开的两段(命名者 + 该家的上游 id,见 vendorPartsOf);
// day_bucket = floor(atMs / 86_400_000)
// (UTC 日索引)。unit_price = 该日代表价(USD)。
export const tokenPriceHistory = sqliteTable(
  "token_price_history",
  {
    source: text("source").notNull(), // tokenRef 的命名者(如 "coingecko")
    identifier: text("identifier").notNull(), // 该命名者给的上游 id
    dayBucket: integer("day_bucket").notNull(), // UTC 日索引
    unitPrice: real("unit_price").notNull(),
  },
  (t) => [primaryKey({ columns: [t.source, t.identifier, t.dayBucket] })],
);

// —— 新参考层(ADR 0021 / 0022 / 0023,#199 expand)——
// 下面四张与上面那套并存到 #202:旧 oracle 读旧表、新 oracle 读新表,expand 期两边都对。

// 一个用户对某个命名者叫法的一条映射:「他的 tk_xxx 在 <namer> 那里叫 <local_name>」。
// 一笔持仓的 tokenRef 拆成两段存(不是整串一列):反查「某个 Token 在当前上游那里叫什么」
// 走 (token_id, namer) 索引;整串一列得 LIKE。与 global_token_ref_index 同两个词。
//
// **PK 带 user_id。** 票上原写 PK(namer, local_name) —— 那是代币表还全局时的写法:
// tokens 转 per-user 之后两个用户都持有 BTC,`coingecko/bitcoin` 会各指一行,主键必然撞。
//
// 「一个 Token 在一个命名者下最多一条 ref」(即一个 Token 只对一个上游币)由 token-store 的
// linkRef 保证,**不做部分唯一索引** —— 那个索引的 WHERE 里要写死 `namer='coingecko'`,
// 等于把厂商名刻进迁移文件,与本片「表名列名零 vendor 字样」的验收项直接冲突。
export const tokenRefs = sqliteTable(
  "token_refs",
  {
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    namer: text("namer").notNull(), // tokenRef 左段:evm:1 / bitcoin / binance / coingecko
    localName: text("local_name").notNull(), // 右段:native / contract:0x… / 上游 id / 场馆代号
    tokenId: text("token_id")
      .notNull()
      .references(() => tokens.id, { onDelete: "cascade" }),
  },
  (t) => [
    primaryKey({ columns: [t.userId, t.namer, t.localName] }),
    // 反查一个 Token 在某命名者下的叫法(TokenInfo.ref 就是这一查)。
    index("token_refs_token_id_namer_idx").on(t.tokenId, t.namer),
  ],
);

// 全局「链上地址 → 某命名者叫它什么」(ADR 0022)。**无 user_id** —— 上游公开知识、
// 可整表重建、删空只是下一轮慢一点。cron 一天一次整份灌;sync 只读本地、零网络。
// 原则 #6「数据访问一律 userId-scoped」的受控例外之一(另一处见 tokenDailyPrices)。
export const globalTokenRefIndex = sqliteTable(
  "global_token_ref_index",
  {
    ref: text("ref").notNull(), // 链上寻址的完整 tokenRef:evm:1/contract:0x… / solana/contract:…
    namer: text("namer").notNull(), // 谁给的别名:coingecko / coinmarketcap / …
    localName: text("local_name").notNull(), // 那家对它的叫法
    updatedAt: integer("updated_at").notNull(), // 这轮刷到的时刻;不删行,据它看哪些没刷到
  },
  (t) => [primaryKey({ columns: [t.ref, t.namer] })],
);

// per-user KV 缓存:只三种键(`warm` / `fx:<币种>` / `platform:<键>`,见 oracle2 的 cache.ts)。
// 整张删空功能不坏,只是慢一点。留 user_id 的理由:per-user 缓存只装这个用户实际碰到的
// (他选的币种、他有持仓的那几条链),全局表得装所有人的并集。
// #202 起取代 fx_rates + platforms 两张全局表。
export const userCache = sqliteTable(
  "user_cache",
  {
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    k: text("k").notNull(),
    v: text("v").notNull(), // JSON.stringify(任意值)
    expiresAt: integer("expires_at").notNull(), // 过期不删:读出带 stale(SWR)
  },
  (t) => [primaryKey({ columns: [t.userId, t.k] })],
);

// 历史日价,**按 tokenRef 全局存**(#199 定案)。一行 = 「某个上游命名的币在某个 UTC 日值多少」。
// 过去某日的价不可变 → 永久缓存,无 TTL 列(今日桶可变,调用方不落此表)。
//
// **表里没有 token_id。** token_id 是 per-user 的随机 UUID,拿它当键的话每个用户各存一份
// BTC 的历史、各自回源补;更要命的是历史不记「是谁给的价」,换源(cgk → cmc)之后同一条
// 曲线前半段一家后半段另一家,接缝跳变还查不出原因。按 tokenRef 存则两家各成一条序列。
// `TokenPriceStore.getDaily(tokenId)` 收的仍是 token_id —— 翻成本表的键在实现里做。
//
// **一列而不是拆两列**(与 global_token_ref_index 相反):这里只有正查,条件永远是
// `token_ref = ? AND day_bucket IN (…)`,没有按命名者单独筛的场景,拆列没有收益。
//
// 与 token_price_history 并存到 #202(那张按 (source, identifier) 存,旧 oracle 还在用)——
// 历史日价是纯缓存、可从上游重建,故不迁数据,新表从空开始。
export const tokenDailyPrices = sqliteTable(
  "token_daily_prices",
  {
    tokenRef: text("token_ref").notNull(), // 完整 tokenRef,如 coingecko/bitcoin
    dayBucket: integer("day_bucket").notNull(), // floor(atMs / 86_400_000),UTC 日索引
    unitPrice: real("unit_price").notNull(), // 该日代表价(USD)
  },
  (t) => [primaryKey({ columns: [t.tokenRef, t.dayBucket] })],
);

// per-user 设置(Phase 3,#82):估值模式(自填价 vs 源价谁优先)。读带缺省(无行 → self-first),
// 故非全用户都有行 —— 仅在改设置时 upsert。user_id 为 PK 且 FK→user(删用户级联清理)。
// 运行时换价源(active_vendor)已废止(ADR 0014)—— CoinGecko 单源。
export const userSettings = sqliteTable("user_settings", {
  userId: text("user_id")
    .primaryKey()
    .references(() => user.id, { onDelete: "cascade" }),
  valuationMode: text("valuation_mode")
    .$type<"self-first" | "source-first">()
    .notNull()
    .default("self-first"),
  updatedAt: integer("updated_at").notNull(), // epoch ms
});

// manual 活动账本(P7.4.1):add/reduce/set 动作日志。当前数量由 deriveAmount 推导、物化进 account.creds.amount
// (provider/sync 不依赖本表)。price 记录单价、留给 M7.3 成本/盈亏,本期不算。与 M7.2 的通用 transactions 表分开。
// manual 多 token(ADR 0017):一个账户持有 N 个手记 token,每 token 一行 token
// (定义:symbol/unitPrice/可选 identifier)。活动账本(manual_activity)挂 token_id,各自折叠 amount。
export const manualToken = sqliteTable(
  "manual_token",
  {
    id: text("id").primaryKey(),
    accountId: text("account_id")
      .notNull()
      .references(() => accounts.id, { onDelete: "cascade" }),
    symbol: text("symbol").notNull(),
    unitPrice: real("unit_price").notNull(),
    identifier: text("identifier"), // 可选 CoinGecko id(消歧/显式寻址;无则按 symbol 归一)
    createdAt: integer("created_at").notNull(), // epoch ms
  },
  (t) => [index("manual_token_account_id_idx").on(t.accountId)],
);

export const manualActivity = sqliteTable(
  "manual_activity",
  {
    id: text("id").primaryKey(),
    accountId: text("account_id")
      .notNull()
      .references(() => accounts.id, { onDelete: "cascade" }),
    // 所属 token(ADR 0017)。DB 层可空(SQLite ADD COLUMN NOT NULL 需默认值,且迁移期无真数据);
    // app 层恒设置为非空(recordManualActivity 必传 tokenId)。删 token → 其活动级联清。
    tokenId: text("token_id").references(() => manualToken.id, { onDelete: "cascade" }),
    kind: text("kind").$type<"add" | "reduce" | "set">().notNull(),
    amount: real("amount").notNull(),
    price: real("price"), // 单价(可空),留 M7.3
    fee: real("fee"), // 手续费 USD(可空;成本基元数据,不参与数量折叠 — 供 P/L 片)
    occurredAt: integer("occurred_at").notNull(), // epoch ms
    memo: text("memo"), // 用户手写备注(原 note;为把 note 让给 provider 展示概念而改名)
    createdAt: integer("created_at").notNull(),
  },
  (t) => [
    index("manual_activity_account_id_occurred_at_idx").on(t.accountId, t.occurredAt),
    // per-token 折叠(deriveAmount)走这条:按 token 取活动、occurredAt 升序。
    index("manual_activity_token_id_occurred_at_idx").on(t.tokenId, t.occurredAt),
  ],
);
