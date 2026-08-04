import type { ConnectorId } from "@folio/connectors";
import type { BalanceKind } from "@folio/connectors-basic";
import { sql } from "drizzle-orm";
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
    // 账户所在的链 ∪ 场馆(Platform)。原名 `network` —— 与领域词汇表统一(#203):
    // Platform 是资深概念(见 ADR 0009 的命名注),而 network 是它退休前的旧叫法,只剩这一处。
    // 与 `snapshot_balances.platform` 同一口径,但粒度不同:这里是账户级(用户建账户时选的),
    // 那里是持仓级(一个 evm 账户的持仓会散落到多条链)。
    platform: text("platform"),
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

// —— Portfolio(命名账户集,ADR 0033)——
// 每用户 ≥1 个 Portfolio、恰一个 is_default(下方部分唯一索引保证)。总览 / 账户页 / Insights 都按
// 「当前选中的 Portfolio」聚合;顶层净值 = 选中 Portfolio 的 Σ,默认选中 is_default 那个。
// 「观察一个账户但不计入净值」= 把它放进一个非默认 Portfolio —— 它就自然不在默认视图里。
export const portfolios = sqliteTable(
  "portfolios",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    isDefault: integer("is_default", { mode: "boolean" }).notNull().default(false),
    sortOrder: integer("sort_order").notNull().default(0),
    createdAt: integer("created_at").notNull(), // epoch ms
  },
  (t) => [
    index("portfolios_user_id_idx").on(t.userId),
    // 每用户恰一个默认 Portfolio。部分唯一索引是**真正防并发双默认**那道:ensureDefaultPortfolio 的
    // find-or-create 在单实例下先挡一次,但 Workers 多实例「先查后插」不原子,靠这条唯一约束兜底。
    uniqueIndex("portfolios_user_default_uidx").on(t.userId).where(sql`${t.isDefault} = 1`),
  ],
);

// 账户 ↔ Portfolio 归属:**先锁一对一**(UNIQUE(account_id))。显式归属 —— 每个账户恰一行归属
// (存量由迁移 backfill,新账户由 db 层 createAccount/importAccount 建账户时一并插)。
// 「以后升 M:N」= 去掉 account 唯一索引即可,`accounts` 表始终不动、无数据迁移。
// 删账户 → 归属行经 cascade 清;删 Portfolio → 其归属行经 cascade 清(管理侧先把成员退回默认再删,见 ADR)。
export const portfolioAccounts = sqliteTable(
  "portfolio_accounts",
  {
    portfolioId: text("portfolio_id")
      .notNull()
      .references(() => portfolios.id, { onDelete: "cascade" }),
    accountId: text("account_id")
      .notNull()
      .references(() => accounts.id, { onDelete: "cascade" }),
  },
  (t) => [
    primaryKey({ columns: [t.portfolioId, t.accountId] }),
    // 一对一锁 + 反查「某账户归属哪个 Portfolio」的索引二合一。升 M:N 时删这条唯一约束、换成普通索引。
    uniqueIndex("portfolio_accounts_account_uidx").on(t.accountId),
  ],
);

// —— Tag(Portfolio 内软标签,ADR 0034)——
// 账户的软标签:一账户可挂多个(M:N,见 account_tags),做 Portfolio 内的横切分组用。
// **归属某个 Portfolio**(`portfolio_id`)—— 账户只能打其所在 Portfolio 的 Tag;是 Portfolio 内的
// 再分组,不是硬隔断(硬隔断是 Portfolio 自己)。删 Portfolio → 其 Tag 经 cascade 清。
// 与 Portfolio 是两回事,别混:Portfolio 选中即视图(减法),Tag 只是给账户贴的标签(横切)。
export const tags = sqliteTable(
  "tags",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    portfolioId: text("portfolio_id")
      .notNull()
      .references(() => portfolios.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    sortOrder: integer("sort_order").notNull().default(0),
    createdAt: integer("created_at").notNull(), // epoch ms
  },
  (t) => [
    index("tags_user_id_idx").on(t.userId),
    index("tags_portfolio_id_idx").on(t.portfolioId),
    // 同 Portfolio 内 Tag 名唯一,**忽略大小写**(表达式索引 lower(name);首尾空格由 ops 层 trim 后落库)。
    // 这是真正防并发重名的那道 —— ops 的先查后插在单实例下先挡一次,Workers 多实例靠这条兜底。
    uniqueIndex("tags_user_portfolio_name_uidx").on(t.userId, t.portfolioId, sql`lower(${t.name})`),
  ],
);

// 账户 ↔ Tag(M:N,ADR 0034)。与 portfolio_accounts 唯一的差异:**不加** UNIQUE(account_id) ——
// 一个账户可挂多个 Tag。删 Tag → 其关联行经 cascade 清;删账户 → 同理。
// account_id 上单独一条索引:给「清空某账户全部 Tag」(账户 move Portfolio 时,见 assignAccountToPortfolio)
// 与「某账户有哪些 Tag」的反查走。
export const accountTags = sqliteTable(
  "account_tags",
  {
    tagId: text("tag_id")
      .notNull()
      .references(() => tags.id, { onDelete: "cascade" }),
    accountId: text("account_id")
      .notNull()
      .references(() => accounts.id, { onDelete: "cascade" }),
  },
  (t) => [
    primaryKey({ columns: [t.tagId, t.accountId] }),
    index("account_tags_account_id_idx").on(t.accountId),
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
    amount: real("amount").notNull(),
    usdValue: real("usd_value").notNull(),
    kind: text("kind").$type<BalanceKind>().notNull(),
    // provider 自带单价(oracle 多源 Phase 3):估值「原料」,冻结。usd_value 是成品(revalue 按当时 mode 算);
    // 当前视图从「amount + self_price + 实时源价 + 当前 mode」现推 → 切源/切开关可逆、自带价不丢。
    selfPrice: real("self_price"),
    // 这笔持仓所在的链 ∪ 场馆(Platform),由 provider 随 Balance 直接报(ADR 0021 / #193)。
    // 可空:本列之前写下的行没有值 —— 读端退回账户的 connectorId,下次同步即补上。
    platform: text("platform"),
    // 认定冻进快照(ADR 0021 / #199 expand):写快照前经 mint 换出的代币行 id。
    // 显示名(symbol / name)从此只住 Token 那一行,读端按 token_id 取 —— 快照不再各存一份
    // (#243 删了 symbol / token_ref 两列)。**必填**(#243):sync 经 mint 恒给,手记合成也带;
    // 唯一还写空值的活口是 v2 导入 —— 有意让它撞约束(旧格式没有身份可落),#204 的 v3 导入
    // 携带 token 身份后恢复。
    //
    // **刻意不加外键**(约束是 NOT NULL,不是 FK)。两个理由:① `TokenStore.merge` 删旧代币行前会把
    // 历史行一并改指,有外键反而让「删用户」这类级联的执行顺序变成雷 —— tokens 经 user_id 级联删、
    // snapshot_balances 经 snapshots 级联删,两条独立分支的先后 SQLite 不保证,
    // 先删 tokens 就撞约束(packages/db 的测试 teardown 正是直接删 user);
    // ② 快照是不可变的历史事实,代币表是可变的参考层,让前者的存在挡住后者的维护是反的。
    // 代价是 merge 漏改指会留下悬空 id → 由 token-store 的 merge 测试盯住。
    tokenId: text("token_id").notNull(),
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
  // 是用户私有数据。必填(#243 收尾):旧的全局行(userId 为空)随 #202 一起清掉了,写路径
  // 恒经 per-user store 落 userId,导入不建代币行 —— 再没有产生空 userId 的路径。
  userId: text("user_id")
    .notNull()
    .references(() => user.id, { onDelete: "cascade" }),
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
  // **用户自己声明的单价**(#203,原 `manual_token.unit_price`)。与上面的 `unit_price` 是两件事:
  // 那个是市场价(上游给的,会过期会刷新),这个是用户手敲的,只在市场不认识这个币时才用得上
  // (`buildManualSnapshot` 的 `prices[i] ?? selfPrice`)。永不被上游覆盖。
  //
  // 住在 `tokens` 而不是另开一张表:代币表已经是 per-user 的(ADR 0021),「我管这个币叫什么、
  // 我认为它值多少」是同一类用户私有数据。代价是它**每个币一份、不是每个账户一份** —— 两个手记
  // 账户持同一个没被收录的币时共用这个声明价。判断是这样更对(同一个币在同一个用户眼里就该一个价),
  // 而且账户之间的差异本来就由各自的账本承载。
  selfPrice: real("self_price"),
});

// 旧参考层的四张全局表 —— `token_vendor_ids` / `token_index` / `token_meta` / `token_price_history` ——
// 随旧 oracle 一起退场(#202)。它们的活儿都被下面这套 per-user 表接了:vendor 映射与 tokenRef 指针
// → `token_refs`,warm 标量 → `user_cache`,历史日价 → `token_daily_prices`(按 tokenRef 全局存)。
// `fx_rates` / `platforms` 两张更早在 #202b 就并进了 `user_cache`。

// —— 参考层(ADR 0021 / 0022 / 0023;#199 expand 建、#202 起是唯一一套)——

// 一个用户对某个命名者叫法的一条映射:「他的 tk_xxx 在 <namer> 那里叫 <local_name>」。
// 一笔持仓的 tokenRef 拆成两段存(不是整串一列):反查「某个 Token 在当前上游那里叫什么」
// 走 (token_id, namer) 索引;整串一列得 LIKE。与 global_token_ref_index 同两个词。
//
// **PK 带 user_id。** 票上原写 PK(namer, local_name) —— 那是代币表还全局时的写法:
// tokens 转 per-user 之后两个用户都持有 BTC,`coingecko/bitcoin` 会各指一行,主键必然撞。
//
// 「一个 Token 在一个命名者下最多一条 ref」(即一个 Token 只对一个上游币)由下面的唯一索引
// `(user_id, token_id, namer)` 在 DB 层保证 —— `linkRef` 的应用层检查在单实例下先挡一道,
// 但 Workers 多实例并发时「先查后写」不是原子的(两个实例可能都读到「还没有」再各插一条),
// 唯一约束是唯一真正防竞态的那道。
//
// **刻意是厂商中立的**:索引落在 `namer` 列上、不写死 `coingecko`,所以它对每个命名者都成立
// (evm:1 / bitcoin / binance / coingecko 一视同仁),既堵住了「一个 Token 挂两个上游币」的
// 数据损坏,又不把厂商名刻进迁移文件 —— 与本片「表名列名零 vendor 字样」的验收项不冲突。
export const tokenRefs = sqliteTable(
  "token_refs",
  {
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    namer: text("namer").notNull(), // tokenRef 左段:evm:1 / bitcoin / binance / coingecko
    localName: text("local_name").notNull(), // 右段(四形状,ADR 0020 第四轮):native / contract:0x… / issued:… / custom:…
    tokenId: text("token_id")
      .notNull()
      .references(() => tokens.id, { onDelete: "cascade" }),
  },
  (t) => [
    primaryKey({ columns: [t.userId, t.namer, t.localName] }),
    // 一个 Token 在一个命名者下最多一条 ref(见表头注释)。反查「某 Token 在某命名者下叫什么」
    // (TokenInfo.ref 那一查)也正好走这个索引的前缀。
    uniqueIndex("token_refs_token_id_namer_uidx").on(t.userId, t.tokenId, t.namer),
  ],
);

// 全局「链上地址 → 某命名者叫它什么」(ADR 0022)。**无 user_id** —— 上游公开知识、
// 可整表重建、删空只是下一轮慢一点。cron 一天一次整份灌;sync 只读本地、零网络。
// 原则 #6「数据访问一律 userId-scoped」的受控例外之一(另一处见 tokenDailyPrices)。
// **表里有两条 ref**(链上寻址的 + 上游命名的),故列名带 `upstream_` 前缀区分谁是谁(#228 / ADR 0022):
//   chain_ref            链上寻址的完整 tokenRef;左段 `evm:1` 本身就是个命名者(链)
//   upstream             另一个命名者 —— 上游(coingecko / …),**不是链**
//   upstream_local_name  上游 ref 的 localName **规范形**(`issued:bitcoin`,不是裸 `bitcoin`)
// 两列 (upstream, upstream_local_name) 拼回整条 upstream ref。`token_refs` 只有一条 ref → 不加前缀。
export const globalTokenRefIndex = sqliteTable(
  "global_token_ref_index",
  {
    chainRef: text("chain_ref").notNull(), // 链上寻址:evm:1/contract:0x… / solana/contract:…
    upstream: text("upstream").notNull(), // 上游命名者:coingecko / coinmarketcap / …(不是链)
    upstreamLocalName: text("upstream_local_name").notNull(), // 上游 ref 的 localName 规范形:issued:bitcoin
    updatedAt: integer("updated_at").notNull(), // 这轮刷到的时刻;不删行,据它看哪些没刷到
  },
  (t) => [primaryKey({ columns: [t.chainRef, t.upstream] })],
);

// per-user KV 缓存:只三种键(`warm` / `fx:<币种>` / `platform:<键>`,见 oracle 的 cache.ts)。
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

// manual 活动账本(P7.4.1):add/reduce/set 动作日志。**它是手记持仓的唯一事实源**(#203):
// 数量由 deriveAmount 现算,不再物化进 `account.creds`(那个投影连同 manual provider 一起删了 ——
// 四个值全部落进真表之后,provider 只是「app 写进 JSON 列 → 再读回来」的空转)。
// price 记录单价、留给 M7.3 成本/盈亏,本期不算。与 M7.2 的通用 transactions 表分开。
//
// 一个手记账户持有哪些币 = **本表里它出现过的 token**(不再有 manual_token 那张关系表):
// 币的身份/名字/图/上游 ref 在 `tokens` + `token_refs`,用户声明的单价在 `tokens.self_price`。
export const manualActivity = sqliteTable(
  "manual_activity",
  {
    id: text("id").primaryKey(),
    accountId: text("account_id")
      .notNull()
      .references(() => accounts.id, { onDelete: "cascade" }),
    // 所属 token(ADR 0017)。**#203 起指 `tokens.id`** —— 手记的币不再另有一张表,它就是这个用户
    // `tokens` 里的一行(symbol / 名字 / 图 / 上游 ref 全在那儿,声明价在 `self_price`)。
    // 于是「这个手记账户持有哪些币」= 它账本里出现过的 token,不必再存一份账户↔币的关系。
    // DB 层可空(历史遗留行);app 层恒非空。删 token → 其活动级联清。
    tokenId: text("token_id").references(() => tokens.id, { onDelete: "cascade" }),
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
