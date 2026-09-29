// 往 perf 专用的本地 D1(Miniflare SQLite 文件)里灌一份确定性的「老用户」数据集。
//
// 直接写 SQLite 文件(node:sqlite),不走 `/api/import`:几万行快照走 HTTP 要几分钟,直写一两秒。
// **worker 必须是停着的** —— workerd 自己也开着这个文件,两边同时写会撞锁。
//
// 确定性:id 由「种类 + 序号」散列出来,数值是序号的函数;只有时间戳锚在「当前整点」上 ——
// 「现在」本身就是被测的东西(getSnapshots now / 24h 窗口),锚死一个过去的时刻反而测不到它。
//
// **刻意不造 manual 账户**:有它在,每次 getSnapshots / getPortfolioHistory 都会去 CoinGecko 取
// 今日价(今日桶永不缓存),沙箱里出网被挡,一发 36s —— 测出来的是网络,不是 CPU。
import { createCipheriv, createHash, randomBytes } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  DAILY_PRICE_DAYS,
  DAILY_PRICE_TOKENS,
  DAY_MS,
  HOUR_MS,
  MIGRATIONS_DIR,
  PERF_STATE_DIR,
} from "./constants.mjs";

const D1_DIR = join(PERF_STATE_DIR, "v3", "d1", "miniflare-D1DatabaseObject");

/** better-auth 的表 —— 重灌时保留(用户、会话都在里面),其余业务表整表清空。 */
const AUTH_TABLES = new Set(["user", "session", "account", "verification", "passkey"]);

// 账户模板:一个 perf 数据集按 `--accounts N` 从这里循环取。nBal = 每张快照几行持仓。
const ACCOUNT_TEMPLATES = [
  { connectorId: "binance", platform: "binance", label: "Binance main", kind: "spot", nBal: 14 },
  { connectorId: "okx", platform: "okx", label: "OKX", kind: "spot", nBal: 9 },
  { connectorId: "bybit", platform: "bybit", label: "Bybit", kind: "spot", nBal: 7 },
  { connectorId: "evm", platform: "evm:1", label: "Ledger EVM", kind: "spot", nBal: 12 },
  { connectorId: "evm", platform: "evm:42161", label: "Arb hot wallet", kind: "spot", nBal: 8 },
  { connectorId: "bitcoin", platform: "bitcoin", label: "BTC cold", kind: "spot", nBal: 1 },
  { connectorId: "solana", platform: "solana", label: "Solana wallet", kind: "spot", nBal: 6 },
  { connectorId: "hyperliquid", platform: "hyperliquid", label: "HL perp", kind: "perp", nBal: 4 },
];

const SYMBOLS = [
  "BTC",
  "ETH",
  "SOL",
  "USDT",
  "USDC",
  "BNB",
  "XRP",
  "ADA",
  "DOGE",
  "AVAX",
  "LINK",
  "DOT",
  "MATIC",
  "TON",
  "TRX",
  "SHIB",
  "LTC",
  "BCH",
  "NEAR",
  "APT",
  "ARB",
  "OP",
  "SUI",
  "ATOM",
  "FIL",
  "INJ",
  "HBAR",
  "ICP",
  "IMX",
  "STX",
];

/** 现汇率(每单位多少 USD)—— 预先放进缓存,读路径就不必出网。 */
const FX_USD_PER_UNIT = { EUR: 1.08, GBP: 1.27, CNY: 0.14, JPY: 0.0067 };

/** 缓存条目的有效期:远大于一次 perf 运行,保证整轮都是命中。 */
const CACHE_TTL_MS = 30 * DAY_MS;
/** 代币价的新鲜期:在此之内 enrichment 不回源。 */
const PRICE_TTL_MS = DAY_MS;
/** 快照记在整点后一分钟,与生产 sweep 的节拍(每小时一次)同形。 */
const SNAPSHOT_OFFSET_MS = 60_000;
/** 持仓数量随时间的正弦扰动:周期与幅度。纯粹为了让曲线不是一条直线。 */
const DRIFT_PERIOD_H = 11;
const DRIFT_AMPLITUDE = 0.08;
/** 账户与组合的「创建时间」往前推多少天。 */
const HISTORY_AGE_DAYS = 90;

/** AES-GCM 的参数 —— 与 `@folio/connectors-basic` 的 crypto.ts 逐项一致(那边是 Web Crypto)。 */
const SECRET_KEY_BYTES = 32;
const GCM_IV_BYTES = 12;

/**
 * 按 app 的规矩封一个 secret 字段:`base64(IV(12) ‖ 密文 ‖ GCM tag)`。Web Crypto 的 AES-GCM 输出
 * 就是「密文 ‖ tag」,所以这里拼出来的与 `encrypt()` 同形,worker 用同一把 SECRETS_KEY 解得开。
 */
function sealSecret(plaintext, secretsKey) {
  const key = Buffer.from(secretsKey, "base64");
  if (key.length !== SECRET_KEY_BYTES) throw new Error("SECRETS_KEY must be base64 of 32 bytes");
  const iv = randomBytes(GCM_IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const body = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return Buffer.concat([iv, body, cipher.getAuthTag()]).toString("base64");
}

/**
 * 一个账户的 creds map(存库形状):secret 字段封好,public / semi 明文 —— 与 `sealCreds` 同一份规矩
 * (字段表见各 connector 的 account.creds)。凭据是假的:同步打到的是本机假上游
 * (`fake-upstream.mjs`),它不验签。读路径(perf:cpu)不解密,只看得到 semi 的打码与 public。
 */
function credsFor(connectorId, i, secretsKey) {
  const seal = (v) => sealSecret(v, secretsKey);
  const evmAddress = `0x${createHash("sha256").update(`folio-perf:addr:${i}`).digest("hex").slice(0, 40)}`;
  switch (connectorId) {
    case "binance":
    case "bybit":
      return {
        apiKey: `perf-${connectorId}-key-${i}`,
        secret: seal(`perf-${connectorId}-secret-${i}`),
      };
    case "okx":
      return {
        apiKey: `perf-okx-key-${i}`,
        secret: seal(`perf-okx-secret-${i}`),
        passphrase: seal(`perf-okx-pass-${i}`),
      };
    case "bitcoin":
      return { addressOrXpub: "bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq" };
    case "solana":
      return {
        address: `PerfSo1${createHash("sha256").update(`sol:${i}`).digest("hex").slice(0, 37)}`,
      };
    default:
      // evm / hyperliquid:一个 EVM 地址。
      return { address: evmAddress };
  }
}

/** 由种子串散列出一个 UUID 形状的 id(版本位 4、变体位 8),同一种子恒得同一个 id。 */
function stableId(seed) {
  const h = createHash("sha256").update(`folio-perf:${seed}`).digest("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

/**
 * perf 库的 SQLite 文件。文件名是 database_id 的散列(Miniflare 的规矩),所以不写死,
 * 按「里面有 user 表」认。迁移没跑过 → 找不到,报错指路。
 */
function perfDbPath() {
  let files = [];
  try {
    files = readdirSync(D1_DIR).filter((f) => f.endsWith(".sqlite") && f !== "metadata.sqlite");
  } catch {
    // 目录还不存在 —— 下面统一报错
  }
  for (const f of files) {
    const path = join(D1_DIR, f);
    const db = new DatabaseSync(path, { readOnly: true });
    try {
      const hasUser = db
        .prepare("select 1 from sqlite_master where type = 'table' and name = 'user'")
        .get();
      if (hasUser) return path;
    } finally {
      db.close();
    }
  }
  throw new Error(`perf D1 not found under ${D1_DIR} — migrations were not applied`);
}

/** perf 用户的 id;还没注册过 → undefined。 */
export function findUserId(email) {
  const db = new DatabaseSync(perfDbPath(), { readOnly: true });
  try {
    return db.prepare("select id from user where email = ?").get(email)?.id;
  } finally {
    db.close();
  }
}

/** 端点入参要用的那几样:默认组合的 id、账户覆盖到的平台。 */
export function endpointInputs(userId) {
  const db = new DatabaseSync(perfDbPath(), { readOnly: true });
  try {
    const row = db
      .prepare("select id from portfolios where user_id = ? order by is_default desc limit 1")
      .get(userId);
    if (!row) throw new Error("perf user has no portfolio — run without --no-seed once");
    const platforms = db
      .prepare("select distinct platform from accounts where user_id = ? and platform is not null")
      .all(userId)
      .map((r) => r.platform);
    return { portfolioId: row.id, platforms };
  } finally {
    db.close();
  }
}

function wipeDataTables(db) {
  const tables = db
    .prepare(
      "select name from sqlite_master where type = 'table' and name not like 'sqlite_%' and name not like '_cf_%' and name != 'd1_migrations'",
    )
    .all()
    .map((r) => r.name)
    .filter((name) => !AUTH_TABLES.has(name));
  for (const t of tables) db.exec(`DELETE FROM "${t}"`);
}

function seedTokens(db, userId, nTokens, now) {
  const insToken = db.prepare(
    "insert into tokens (id,user_id,symbol,name,logo,provider_logo,market_cap_rank,info_expires_at,unit_price,change_24h,price_as_of,price_expires_at,self_price) values (?,?,?,?,?,?,?,?,?,?,?,?,?)",
  );
  const insRef = db.prepare(
    "insert into token_refs (user_id,namer,local_name,token_id) values (?,?,?,?)",
  );
  const tokens = [];
  for (let i = 0; i < nTokens; i++) {
    const sym = SYMBOLS[i % SYMBOLS.length] + (i >= SYMBOLS.length ? String(i) : "");
    const id = stableId(`token:${i}`);
    const price = 0.5 + ((i * 37) % 900) + (i % 7) / 3;
    const localName = `issued:${sym.toLowerCase()}-coin`;
    insToken.run(
      id,
      userId,
      sym,
      `${sym} Token`,
      `https://assets.example/coins/${sym.toLowerCase()}.png`,
      null,
      i + 1,
      now + CACHE_TTL_MS,
      price,
      ((i % 21) - 10) / 2,
      now - 5 * 60_000,
      now + PRICE_TTL_MS,
      null,
    );
    insRef.run(userId, "coingecko", localName, id);
    tokens.push({ id, sym, price, ref: `coingecko/${localName}` });
  }
  return tokens;
}

function seedAccounts(db, userId, portfolioId, nAccounts, now, secretsKey) {
  const insAccount = db.prepare(
    "insert into accounts (id,user_id,connector_id,platform,label,enc_credentials,created_at,archived_at) values (?,?,?,?,?,?,?,?)",
  );
  const insLink = db.prepare(
    "insert into portfolio_accounts (portfolio_id,account_id) values (?,?)",
  );
  const accounts = [];
  for (let i = 0; i < nAccounts; i++) {
    const t = ACCOUNT_TEMPLATES[i % ACCOUNT_TEMPLATES.length];
    const id = stableId(`account:${i}`);
    const label = i < ACCOUNT_TEMPLATES.length ? t.label : `${t.label} #${i}`;
    // 凭据按真账户的形状封好(secret 字段用 SECRETS_KEY 加密):cron 的同步要能真的解开、真的出网
    // (perf:cpu:jobs),否则它在「缺凭据」那一步就跳过,量不到取数与估值。
    const creds = JSON.stringify(credsFor(t.connectorId, i, secretsKey));
    insAccount.run(
      id,
      userId,
      t.connectorId,
      t.platform,
      label,
      creds,
      now - HISTORY_AGE_DAYS * DAY_MS,
      null,
    );
    insLink.run(portfolioId, id);
    accounts.push({ ...t, id });
  }
  return accounts;
}

function seedTags(db, userId, portfolioId, accounts, now) {
  const insTag = db.prepare(
    "insert into tags (id,user_id,portfolio_id,name,sort_order,created_at) values (?,?,?,?,?,?)",
  );
  const insAccountTag = db.prepare("insert into account_tags (tag_id,account_id) values (?,?)");
  for (const [i, name] of ["CEX", "Cold"].entries()) {
    const id = stableId(`tag:${i}`);
    insTag.run(id, userId, portfolioId, name, i, now);
    if (accounts[i]) insAccountTag.run(id, accounts[i].id);
  }
}

// 平台名/图标与现汇率预先进 per-user 缓存(形状见 @folio/oracle 的 platforms.ts / fx.ts),
// 读路径因此零出网。
function seedCache(db, userId, accounts, now) {
  const ins = db.prepare(
    "insert or replace into user_cache (user_id,k,v,expires_at) values (?,?,?,?)",
  );
  for (const key of new Set(accounts.map((a) => a.platform))) {
    ins.run(
      userId,
      `platform:${key}`,
      JSON.stringify({ name: key, logo: `https://assets.example/p/${key}.png` }),
      now + CACHE_TTL_MS,
    );
  }
  for (const [cur, rate] of Object.entries(FX_USD_PER_UNIT)) {
    ins.run(userId, `fx:${cur}`, JSON.stringify(rate), now + CACHE_TTL_MS);
  }
}

function seedSnapshots(db, accounts, tokens, hours, now) {
  const insSnap = db.prepare(
    "insert into snapshots (id,account_id,taken_at,total_usd,note) values (?,?,?,?,?)",
  );
  const insBal = db.prepare(
    "insert into snapshot_balances (id,snapshot_id,amount,usd_value,kind,self_price,platform,token_id,meta_json,note) values (?,?,?,?,?,?,?,?,?,?)",
  );
  const anchor = Math.floor(now / HOUR_MS) * HOUR_MS;
  let nSnap = 0;
  let nBal = 0;
  for (const a of accounts) {
    const held = Array.from({ length: a.nBal }, (_, i) => tokens[(i * 3 + a.nBal) % tokens.length]);
    for (let h = hours; h >= 0; h--) {
      const sid = stableId(`snap:${a.id}:${h}`);
      const rows = held.map((t, i) => {
        const drift = 1 + Math.sin((h + i) / DRIFT_PERIOD_H) * DRIFT_AMPLITUDE;
        const amount = (2 + i) * 1.37 * drift;
        const meta =
          a.kind === "perp"
            ? JSON.stringify({
                coin: t.sym,
                entryPrice: t.price,
                liqPrice: t.price * 0.7,
                leverage: 3,
              })
            : null;
        return { id: stableId(`bal:${sid}:${i}`), amount, usd: amount * t.price * drift, t, meta };
      });
      const total = rows.reduce((sum, r) => sum + r.usd, 0);
      insSnap.run(sid, a.id, anchor - h * HOUR_MS + SNAPSHOT_OFFSET_MS, total, null);
      for (const r of rows) {
        insBal.run(r.id, sid, r.amount, r.usd, a.kind, r.t.price, a.platform, r.t.id, r.meta, null);
      }
      nSnap++;
      nBal += rows.length;
    }
  }
  return { nSnap, nBal };
}

// 快照的日汇总(FOL-91)。生产上它由写快照那个 batch 维护、存量由迁移回填;这里快照是直写
// SQLite 灌的,绕过了写侧 —— 不补的话长窗曲线读到一张空表,量出来的是「没数据」有多快。
// **跑的就是迁移里那条回填语句**(从迁移文件里取,不另抄一份):灌完快照后重算一遍,与存量
// 用户升级那一刻的结果相同。
const DAILY_TOTALS_TABLE = "account_daily_totals";

function seedDailyTotals(db) {
  const file = readdirSync(MIGRATIONS_DIR).find(
    (f) => f.endsWith(".sql") && f.includes(DAILY_TOTALS_TABLE),
  );
  // 没有这条迁移 = 被测的是 FOL-91 之前的代码(前后对比时的 BEFORE 那份),那时没有这张表 —— 跳过。
  if (!file) return null;
  const backfill = readFileSync(join(MIGRATIONS_DIR, file), "utf8")
    .split("--> statement-breakpoint")
    .find((stmt) => stmt.includes(`INSERT OR REPLACE INTO \`${DAILY_TOTALS_TABLE}\``));
  if (!backfill) throw new Error(`no backfill statement in ${file}`);
  db.exec(backfill);
  return db.prepare(`select count(*) as n from ${DAILY_TOTALS_TABLE}`).get().n;
}

function seedDailyPrices(db, tokens, now) {
  const ins = db.prepare(
    "insert or replace into token_daily_prices (token_ref,day_bucket,unit_price) values (?,?,?)",
  );
  let n = 0;
  for (const t of tokens.slice(0, DAILY_PRICE_TOKENS)) {
    for (let d = 0; d < DAILY_PRICE_DAYS; d++) {
      ins.run(t.ref, Math.floor((now - d * DAY_MS) / DAY_MS), t.price * (1 + (d % 13) / 50));
      n++;
    }
  }
  return n;
}

/**
 * 清空业务表并重灌。返回各表行数,调用方打印出来 —— 数据集大小是结果的一部分,
 * 不同大小的两次运行不可比。
 */
export function seedDataset({ userId, accounts: nAccounts, tokens: nTokens, days, secretsKey }) {
  const db = new DatabaseSync(perfDbPath());
  let open = false;
  try {
    // 整表清空不按父子顺序删 → 先关外键。PRAGMA 在事务里是空操作,所以必须在 BEGIN 之前。
    db.exec("PRAGMA foreign_keys=OFF");
    const now = Date.now();
    db.exec("BEGIN");
    open = true;
    wipeDataTables(db);
    const portfolioId = stableId("portfolio:main");
    db.prepare(
      "insert into portfolios (id,user_id,name,is_default,sort_order,created_at) values (?,?,?,?,?,?)",
    ).run(portfolioId, userId, "Main", 1, 0, now - HISTORY_AGE_DAYS * DAY_MS);
    db.prepare(
      "insert into user_settings (user_id,valuation_mode,updated_at,hide_balances) values (?,?,?,?)",
    ).run(userId, "self-first", now, 0);
    const tokens = seedTokens(db, userId, nTokens, now);
    const accounts = seedAccounts(db, userId, portfolioId, nAccounts, now, secretsKey);
    seedTags(db, userId, portfolioId, accounts, now);
    seedCache(db, userId, accounts, now);
    const { nSnap, nBal } = seedSnapshots(db, accounts, tokens, days * 24, now);
    const nDailyTotals = seedDailyTotals(db);
    const nDaily = seedDailyPrices(db, tokens, now);
    db.exec("COMMIT");
    open = false;
    return {
      portfolioId,
      accounts: accounts.length,
      tokens: tokens.length,
      snapshots: nSnap,
      snapshotBalances: nBal,
      dailyTotals: nDailyTotals,
      dailyPrices: nDaily,
    };
  } catch (err) {
    if (open) db.exec("ROLLBACK");
    throw err;
  } finally {
    db.close();
  }
}

/**
 * 让库「老一个小时」:把 perf 用户所有代币的价标成过期(`PRICE_TTL_MS` 是 30 分钟)。
 *
 * 为什么要它:生产的整点 sweep 每次都隔着一小时,上一轮取的价**一定**过期了 —— 那一轮必然去
 * CoinGecko 取价、写价。连着触发几次 cron 的话,第二次起价都还新鲜,那一截就被跳过,量小了。
 * 其余缓存(汇率 6h、平台 30d、目录 7d)在生产的整点 sweep 里也多半是命中,不动。
 * worker 必须停着(同 seedDataset)。
 */
export function expirePrices(userId) {
  const db = new DatabaseSync(perfDbPath());
  try {
    const past = Date.now() - HOUR_MS;
    return db
      .prepare(
        "update tokens set price_expires_at = ?, price_as_of = ? where user_id = ? and price_expires_at is not null",
      )
      .run(past, past - HOUR_MS, userId).changes;
  } finally {
    db.close();
  }
}

/**
 * 清掉这个用户的同步轮(`sync-round:*`,ADR 0048)。`perf:cpu:jobs --cron-only` 不等队列排空就停 worker,
 * 留下没收官的轮;不清的话下一次 cron 在心跳期内看到「活轮还在」就不投 `sync-account`,量的就不是
 * 同一件事了。
 */
export function clearSyncRounds(userId) {
  const db = new DatabaseSync(perfDbPath());
  try {
    return db
      .prepare("delete from user_cache where user_id = ? and k like 'sync-round:%'")
      .run(userId).changes;
  } finally {
    db.close();
  }
}

/** 全局映射表(`global_token_ref_index`)有几行 —— 0 = 还没刷过,sweep 认不出链上的币。 */
export function refIndexRowCount() {
  const db = new DatabaseSync(perfDbPath(), { readOnly: true });
  try {
    return db.prepare("select count(*) as n from global_token_ref_index").get().n;
  } finally {
    db.close();
  }
}
