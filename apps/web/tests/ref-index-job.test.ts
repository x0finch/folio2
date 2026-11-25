import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { RemoteSql, RemoteStatement } from "@folio/db";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createD1HttpSql, D1_API_BASE, MAX_BOUND_PARAMS } from "../scripts/ref-index/d1-http";
import { refreshRefIndex, tallied } from "../scripts/ref-index/job";
import { openSqliteFile, resolveLocalDb } from "../scripts/ref-index/sqlite-file";

const MIGRATIONS = join(import.meta.dirname, "../../../packages/db/drizzle");
const CG_BASE = "http://coingecko.test/api/v3";
const CG = { COINGECKO_PRO_API_KEY: "test-key", COINGECKO_API_BASE: CG_BASE };
const MAX_STATEMENTS_PER_BATCH = 50;

interface Coin {
  id: string;
  platforms: Record<string, string>;
}

const PLATFORMS = [
  { id: "ethereum", chain_identifier: 1 },
  { id: "polygon-pos", chain_identifier: 137 },
  { id: "solana", chain_identifier: null },
  { id: "sui", chain_identifier: null },
  { id: "cosmos", chain_identifier: null },
];
const hex = (n: number) => `0x${n.toString(16).padStart(40, "0")}`;
const coins = (n: number): Coin[] =>
  Array.from({ length: n }, (_, i) => ({
    id: `coin-${i}`,
    platforms: { ethereum: hex(i * 2 + 1), "polygon-pos": hex(i * 2 + 2) },
  }));
const N_COINS = 3000;

let dir: string;
let dbPath: string;

function mockCoinGecko(list: () => unknown, status = 200, d1?: RemoteSql) {
  return vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
    if (d1 && url.href.startsWith(D1_API_BASE)) {
      const body = JSON.parse(String(init?.body));
      const stmts: RemoteStatement[] = (body.batch ?? [body]).map(
        (s: { sql: string; params: unknown[] }) => ({ ...s, method: "all" }),
      );
      const out = await d1.batch(stmts);
      return Response.json({
        success: true,
        errors: [],
        result: out.map((rows) => ({ results: { columns: [], rows }, success: true })),
      });
    }
    if (url.pathname.endsWith("/coins/list")) {
      return status === 200
        ? Response.json(list())
        : new Response("nope", { status, headers: { "content-type": "text/plain" } });
    }
    if (url.pathname.endsWith("/asset_platforms")) return Response.json(PLATFORMS);
    return new Response("unexpected", { status: 404 });
  });
}

function recording(inner: RemoteSql) {
  const batches: RemoteStatement[][] = [];
  const sql: RemoteSql = {
    query: (s) => inner.query(s),
    batch: (stmts) => {
      batches.push([...stmts]);
      return inner.batch(stmts);
    },
  };
  return { sql, batches };
}

const count = () => {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    return (db.prepare("select count(*) as n from global_token_ref_index").get() as { n: number })
      .n;
  } finally {
    db.close();
  }
};

async function run(list: Coin[], opts: { dryRun?: boolean } = {}) {
  mockCoinGecko(() => list);
  const file = openSqliteFile(dbPath);
  const rec = recording(file.sql);
  const { sql, tally } = tallied(rec.sql, opts.dryRun ?? false);
  try {
    const report = await refreshRefIndex(sql, CG);
    return { report, tally, batches: rec.batches };
  } finally {
    file.close();
    vi.restoreAllMocks();
  }
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "folio-ref-index-"));
  dbPath = join(dir, "d1.sqlite");
  const db = new DatabaseSync(dbPath);
  for (const f of readdirSync(MIGRATIONS)
    .filter((f) => f.endsWith(".sql"))
    .sort()) {
    db.exec(readFileSync(join(MIGRATIONS, f), "utf8"));
  }
  db.close();
});

afterEach(() => {
  vi.restoreAllMocks();
  rmSync(dir, { recursive: true, force: true });
});

describe("refreshRefIndex: table refresh on Node", () => {
  it("first round inserts all; each statement ≤ D1's bound-parameter limit, each batch capped", async () => {
    const { report, batches } = await run(coins(N_COINS));
    expect(report).toMatchObject({
      lastRefreshedAt: null,
      rows: N_COINS * 2,
      inserted: N_COINS * 2,
      updated: 0,
      deleted: 0,
      unmatchedPlatforms: [],
    });
    expect(count()).toBe(N_COINS * 2);
    expect(batches.length).toBeGreaterThan(1);
    for (const batch of batches) {
      expect(batch.length).toBeLessThanOrEqual(MAX_STATEMENTS_PER_BATCH);
      for (const s of batch) expect(s.params.length).toBeLessThanOrEqual(MAX_BOUND_PARAMS);
    }
  });

  it("second round with upstream unchanged: zero writes (diff), keyset spanned more than one page", async () => {
    await run(coins(N_COINS));
    const { report, tally } = await run(coins(N_COINS));
    expect(report).toMatchObject({ inserted: 0, updated: 0, deleted: 0 });
    expect(report.lastRefreshedAt).not.toBeNull();
    expect(tally.writeStatements).toBe(0);
    expect(tally.reads).toBeGreaterThanOrEqual(3);
  });

  it("upstream rename / delisting / addition: each lands the right row count", async () => {
    await run(coins(10));
    const next = coins(10)
      .filter((c) => c.id !== "coin-3")
      .map((c) => (c.id === "coin-5" ? { ...c, id: "coin-5-renamed" } : c));
    next.push({ id: "new-coin", platforms: { ethereum: hex(9999) } });
    const { report } = await run(next);
    expect(report).toMatchObject({ inserted: 1, updated: 2, deleted: 2 });
    expect(count()).toBe(20 - 2 + 1);
  });

  it("dry run: the diff is computed, no row written", async () => {
    const { report, tally, batches } = await run(coins(100), { dryRun: true });
    expect(report.inserted).toBe(200);
    expect(tally.writeStatements).toBeGreaterThan(0);
    expect(batches).toEqual([]);
    expect(count()).toBe(0);
  });

  it("upstream failure: rejects with a readable sentence, nothing in the database changed", async () => {
    mockCoinGecko(() => [], 401);
    const file = openSqliteFile(dbPath);
    try {
      await expect(refreshRefIndex(file.sql, CG)).rejects.toThrow(/coingecko/);
    } finally {
      file.close();
    }
    expect(count()).toBe(0);
  });
});

describe("refreshRefIndex over the D1 REST transport (fetch is fake, backed by SQLite)", () => {
  it("first round inserts all, second round zero writes: same result as the local file path", async () => {
    const file = openSqliteFile(dbPath);
    try {
      const d1 = createD1HttpSql({ accountId: "a", databaseId: "d", token: "t" });
      mockCoinGecko(() => coins(N_COINS), 200, file.sql);
      const first = await refreshRefIndex(d1, CG);
      expect(first).toMatchObject({ inserted: N_COINS * 2, updated: 0, deleted: 0 });
      vi.restoreAllMocks();
      mockCoinGecko(() => coins(N_COINS), 200, file.sql);
      const second = await refreshRefIndex(d1, CG);
      expect(second).toMatchObject({ inserted: 0, updated: 0, deleted: 0 });
    } finally {
      file.close();
    }
    expect(count()).toBe(N_COINS * 2);
  });
});

describe("resolveLocalDb: which file --local points to", () => {
  it("given a file it is used; given a directory, finds the one in Miniflare's D1 directory that has the mapping table", () => {
    expect(resolveLocalDb(dbPath)).toBe(dbPath);
    expect(resolveLocalDb(dir)).toBe(dbPath);
  });

  it("two in the directory both have the table: errors listing them, no guessing", () => {
    const other = join(dir, "other.sqlite");
    const db = new DatabaseSync(other);
    db.exec("create table global_token_ref_index (x)");
    db.close();
    expect(() => resolveLocalDb(dir)).toThrow(/several D1 files/);
  });
});
