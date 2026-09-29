import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { RemoteSql, RemoteStatement } from "@folio/db";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createD1HttpSql, D1_API_BASE, MAX_BOUND_PARAMS } from "../scripts/ref-index/d1-http";
import { refreshRefIndex, tallied } from "../scripts/ref-index/job";
import { openSqliteFile, resolveLocalDb } from "../scripts/ref-index/sqlite-file";

// 刷全局映射表挪出 Worker 之后的那条路(FOL-85,ADR 0056):**同一套** 转换 + 差量 + 分批,跑在 Node 上、
// 接一条 SQL 传输。这里拿一个真 SQLite 文件(套了全部迁移)+ 假的 CoinGecko 两个端点,钉住:
//   · 首轮全插、次轮零写(差量)、上游改名 / 下架 / 新增各落对行数
//   · 每条语句的绑定参数 ≤ D1 上限、每批语句数有顶(D1 REST 那边一批就是一次请求)
//   · 干跑:差量照算、一行不写
//   · 上游失败 → reject,库里什么都没动

const MIGRATIONS = join(import.meta.dirname, "../../../packages/db/drizzle");
const CG_BASE = "http://coingecko.test/api/v3";
// pro 档:测试里连着跑好几轮,别让 keyless 的每分钟 10 发把用例拖慢(闸是真闸)。
const CG = { apiKey: "test-key", pro: true, baseUrl: CG_BASE };
/** `putAll` 每批最多几条语句(global-ref-index.ts 的 STATEMENTS_PER_BATCH)—— 这里只钉上限。 */
const MAX_STATEMENTS_PER_BATCH = 50;

interface Coin {
  id: string;
  platforms: Record<string, string>;
}

// 两条 EVM 链(chain_identifier 1 / 137)。每个币两个地址 → 两行。
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
// 3000 个币 = 6000 行:超过一页 keyset(5000)、超过一批(1000 行),三条路都走到。
const N_COINS = 3000;

let dir: string;
let dbPath: string;

// `d1` 给了就把 D1 REST 的 `/raw` 也接住(背后是同一个 SQLite 文件)—— 走一遍远端那条传输的全程。
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

// 记下传输层看到的每一批写。
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

describe("refreshRefIndex —— Node 上的刷表(FOL-85)", () => {
  it("首轮全插;每条语句 ≤ D1 的绑定参数上限,每批有顶", async () => {
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

  it("次轮上游一字没变 → 零写(差量),keyset 翻了不止一页", async () => {
    await run(coins(N_COINS));
    const { report, tally } = await run(coins(N_COINS));
    expect(report).toMatchObject({ inserted: 0, updated: 0, deleted: 0 });
    expect(report.lastRefreshedAt).not.toBeNull();
    expect(tally.writeStatements).toBe(0);
    // `refreshedAt` 一条 + 至少两页扫描
    expect(tally.reads).toBeGreaterThanOrEqual(3);
  });

  it("上游改名 / 下架 / 新增 → 各落对行数", async () => {
    await run(coins(10));
    const next = coins(10)
      .filter((c) => c.id !== "coin-3") // 下架:两行
      .map((c) => (c.id === "coin-5" ? { ...c, id: "coin-5-renamed" } : c)); // 改名:两行
    next.push({ id: "new-coin", platforms: { ethereum: hex(9999) } }); // 新增:一行
    const { report } = await run(next);
    expect(report).toMatchObject({ inserted: 1, updated: 2, deleted: 2 });
    expect(count()).toBe(20 - 2 + 1);
  });

  it("干跑:差量照算,一行不写", async () => {
    const { report, tally, batches } = await run(coins(100), { dryRun: true });
    expect(report.inserted).toBe(200);
    expect(tally.writeStatements).toBeGreaterThan(0); // 计划里有
    expect(batches).toEqual([]); // 传输层一批都没收到
    expect(count()).toBe(0);
  });

  it("上游失败 → reject 成一句人话,库里什么都没动", async () => {
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

describe("refreshRefIndex over the D1 REST transport(fetch 是假的,背后是 SQLite)", () => {
  it("首轮全插、次轮零写 —— 与本地文件那条路同一个结果", async () => {
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

describe("resolveLocalDb —— --local 指到哪个文件", () => {
  it("给文件就用文件;给目录就在 Miniflare 的 D1 目录里找建过映射表的那一个", () => {
    expect(resolveLocalDb(dbPath)).toBe(dbPath);
    expect(resolveLocalDb(dir)).toBe(dbPath);
  });

  it("目录里两个都建过表 → 报错列出来,不猜", () => {
    const other = join(dir, "other.sqlite");
    const db = new DatabaseSync(other);
    db.exec("create table global_token_ref_index (x)");
    db.close();
    expect(() => resolveLocalDb(dir)).toThrow(/several D1 files/);
  });
});
