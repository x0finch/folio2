// Seeds a deterministic "veteran user" dataset into the perf-only local D1 (a Miniflare SQLite file). It writes the file directly (node:sqlite), not via `/api/import`: tens of thousands of snapshot rows take minutes over HTTP and a second or two directly. The worker must be stopped: workerd has the file open too and concurrent writes would lock.
//
// Deterministic: ids hash from "kind + index" and values are functions of the index; only timestamps anchor to the current hour, since "now" is itself under test (getSnapshots now / 24h window).
//
// Deliberately no manual account: it makes every getSnapshots / getPortfolioHistory fetch today's price from CoinGecko (today's bucket is never cached), and with egress blocked in the sandbox that's 36s per request, measuring the network not CPU.
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

/** better-auth tables are kept on reseed (users and sessions live there); all other business tables are emptied. */
const AUTH_TABLES = new Set(["user", "session", "account", "verification", "passkey"]);

// Account templates, cycled for `--accounts N`. nBal = holdings per snapshot.
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

/** Spot FX rates (USD per unit), preloaded into the cache so the read path needs no egress. */
const FX_USD_PER_UNIT = { EUR: 1.08, GBP: 1.27, CNY: 0.14, JPY: 0.0067 };

/** Cache entry lifetime: far beyond one perf run, so the whole run hits. */
const CACHE_TTL_MS = 30 * DAY_MS;
/** Token price freshness: within it, enrichment doesn't go back to the source. */
const PRICE_TTL_MS = DAY_MS;
/** Snapshots are stamped one minute past the hour, matching the production sweep's hourly cadence. */
const SNAPSHOT_OFFSET_MS = 60_000;
/** Sinusoidal perturbation of holding amounts (period and amplitude), only so curves aren't straight lines. */
const DRIFT_PERIOD_H = 11;
const DRIFT_AMPLITUDE = 0.08;
/** How many days back account and portfolio "created" times go. */
const HISTORY_AGE_DAYS = 90;

/** AES-GCM parameters, identical to `@folio/connectors-basic`'s crypto.ts (Web Crypto there). */
const SECRET_KEY_BYTES = 32;
const GCM_IV_BYTES = 12;

/** Seals a secret field as the app does: `base64(IV(12) || ciphertext || GCM tag)`. Web Crypto's AES-GCM output is already "ciphertext || tag", so this matches `encrypt()` and the worker decrypts it with the same SECRETS_KEY. */
function sealSecret(plaintext, secretsKey) {
  const key = Buffer.from(secretsKey, "base64");
  if (key.length !== SECRET_KEY_BYTES) throw new Error("SECRETS_KEY must be base64 of 32 bytes");
  const iv = randomBytes(GCM_IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const body = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return Buffer.concat([iv, body, cipher.getAuthTag()]).toString("base64");
}

/** One account's creds map (storage shape): secret fields sealed, public / semi plain, as `sealCreds` does (field tables in each connector's account.creds). The credentials are fake: syncs hit the local fake upstream (`fake-upstream.mjs`), which doesn't verify signatures. The read path (perf:cpu) doesn't decrypt and only sees masked semi and public fields. */
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
      // evm / hyperliquid: an EVM address.
      return { address: evmAddress };
  }
}

/** A UUID-shaped id hashed from a seed string (version 4, variant 8); the same seed always gives the same id. */
function stableId(seed) {
  const h = createHash("sha256").update(`folio-perf:${seed}`).digest("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

/** The perf DB's SQLite file. The file name is a database_id hash (Miniflare convention), so it's found by "has a user table" rather than hardcoded; if migrations haven't run it isn't found and the error says what to do. */
function perfDbPath() {
  let files = [];
  try {
    files = readdirSync(D1_DIR).filter((f) => f.endsWith(".sqlite") && f !== "metadata.sqlite");
  } catch {
    // The directory doesn't exist yet: reported below.
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

/** The perf user's id; undefined if not registered yet. */
export function findUserId(email) {
  const db = new DatabaseSync(perfDbPath(), { readOnly: true });
  try {
    return db.prepare("select id from user where email = ?").get(email)?.id;
  } finally {
    db.close();
  }
}

/** What endpoint inputs need: the default portfolio's id and the platforms the accounts cover. */
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
    // Seal credentials in a real account's shape (secret fields encrypted with SECRETS_KEY) so cron syncs can really decrypt and go out to the network (perf:cpu:jobs); otherwise they'd skip at "missing credentials" and fetch and valuation go unmeasured.
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

// Platform names/icons and spot FX rates are preloaded into the per-user cache (shapes in @folio/oracle's platforms.ts / fx.ts), so the read path needs no egress.
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

// The snapshot daily rollup: in production the snapshot write batch maintains it and the migration backfills existing data; here snapshots are written straight into SQLite, bypassing the write side, so without this long-window curves would read an empty table and measure "no data" speed. Runs the migration's own backfill statement (read from the migration file, no copy) after seeding, matching what an existing user gets on upgrade.
const DAILY_TOTALS_TABLE = "account_daily_totals";

function seedDailyTotals(db) {
  const file = readdirSync(MIGRATIONS_DIR).find(
    (f) => f.endsWith(".sql") && f.includes(DAILY_TOTALS_TABLE),
  );
  // Without this migration the code under test predates the rollup (the BEFORE side of a before/after comparison) and has no such table: skip.
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

/** Empties the business tables and reseeds. Returns per-table row counts for the caller to print: dataset size is part of the result and runs of different sizes aren't comparable. */
export function seedDataset({ userId, accounts: nAccounts, tokens: nTokens, days, secretsKey }) {
  const db = new DatabaseSync(perfDbPath());
  let open = false;
  try {
    // A full-table wipe ignores parent/child order, so turn FKs off first. PRAGMA is a no-op inside a transaction, so it must precede BEGIN.
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

/** Ages the DB by an hour: marks all the perf user's token prices expired (`PRICE_TTL_MS` is 30 minutes). Production's hourly sweep always sees prices from over an hour ago, so it always fetches and writes prices; with back-to-back cron triggers, prices are fresh from the second on and that part would be skipped, understating cost. Other caches (FX 6h, platforms 30d, catalog 7d) mostly hit in production's sweep too, so they stay. The worker must be stopped (as in seedDataset). */
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

/** Clears this user's sync rounds (`sync-round:*`). `perf:cpu:jobs --cron-only` stops the worker without waiting for the queue to drain, leaving an unfinished round; otherwise the next cron within the heartbeat sees a live round and posts no `sync-account`, measuring something else. */
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

/** Rows in the global map (`global_token_ref_index`); 0 means never refreshed, so the sweep can't recognise on-chain tokens. */
export function refIndexRowCount() {
  const db = new DatabaseSync(perfDbPath(), { readOnly: true });
  try {
    return db.prepare("select count(*) as n from global_token_ref_index").get().n;
  } finally {
    db.close();
  }
}
