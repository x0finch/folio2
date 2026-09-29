import { type D1Migration, env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import {
  createDataVersionTriggers,
  dropDataVersionTriggers,
  REBUILD_SENSITIVE_TABLES,
} from "../scripts/data-version-triggers";

// 数据版本号触发器 × 表重建(ADR 0057)。drizzle-kit 不认识触发器,改列时照样生成
// `CREATE __new_X → INSERT…SELECT → DROP X → RENAME`;X 一旦是触发器引用的表,RENAME 就以
// `error in trigger …: no such table: main.X` 失败(已在本仓 D1 测试环境复现),DROP 还会静默带走 X
// 自己的触发器。这里守两件事:
//   ① 生成器(`scripts/data-version-triggers.ts`)与库里真实的触发器逐字一致 —— 贴它就等于原样重建;
//   ② 0010 之后的每条迁移:重建 / 删掉敏感表的,必须在开头删光触发器、在末尾全部建回。

const TRIGGER_NAME = /^CREATE TRIGGER `([^`]+)`/;
const REBUILT = /ALTER TABLE\s+[`"]?__new_(\w+)[`"]?\s+RENAME TO/i;
const DROPPED = /DROP TABLE\s+(?:IF EXISTS\s+)?[`"]?(\w+)[`"]?/i;

const norm = (sql: string) => sql.trim().replace(/;$/, "").trim();
const triggerNames = () => createDataVersionTriggers().map((s) => TRIGGER_NAME.exec(s)?.[1] ?? "");

// 返回违规描述;空数组 = 这批迁移都守了规矩。
function rebuildViolations(
  migrations: readonly D1Migration[],
  sensitive: readonly string[],
  names: readonly string[],
): string[] {
  const born = migrations.findIndex((m) => m.queries.some((q) => q.includes("_data_version_")));
  if (born < 0) return [];
  const out: string[] = [];
  for (const m of migrations.slice(born + 1)) {
    const hits = m.queries.flatMap((q, i) => {
      const table = REBUILT.exec(q)?.[1] ?? DROPPED.exec(q)?.[1];
      return table && sensitive.includes(table) ? [{ i, table }] : [];
    });
    if (hits.length === 0) continue;
    const first = Math.min(...hits.map((h) => h.i));
    const last = Math.max(...hits.map((h) => h.i));
    const tables = [...new Set(hits.map((h) => h.table))].join(", ");
    for (const name of names) {
      const dropped = m.queries
        .slice(0, first)
        .some((q) => new RegExp(`DROP TRIGGER\\s+(?:IF EXISTS\\s+)?\`${name}\``).test(q));
      const recreated = m.queries
        .slice(last + 1)
        .some((q) => q.includes(`CREATE TRIGGER \`${name}\``));
      if (!dropped) out.push(`${m.name}: 重建/删了 ${tables},但开头没删 ${name}`);
      if (!recreated) out.push(`${m.name}: 重建/删了 ${tables},但末尾没建回 ${name}`);
    }
  }
  return out;
}

describe("数据版本号触发器 × 表重建", () => {
  it("生成器与库里的触发器逐字一致", async () => {
    const { results } = await env.DB.prepare(
      "SELECT name, sql FROM sqlite_master WHERE type = 'trigger' AND name LIKE '%\\_data\\_version\\_%' ESCAPE '\\' ORDER BY name",
    ).all<{ name: string; sql: string }>();
    const live = results.map((r) => norm(r.sql)).sort();
    const generated = createDataVersionTriggers().map(norm).sort();
    expect(live).toEqual(generated);
  });

  it("触发器引用到的每张表都在 REBUILD_SENSITIVE_TABLES 里", () => {
    const referenced = createDataVersionTriggers().flatMap((sql) =>
      [...sql.matchAll(/(?:ON|FROM|INTO)\s+`(\w+)`/g)].map((m) => m[1]),
    );
    expect([...new Set(referenced)].filter((t) => !REBUILD_SENSITIVE_TABLES.includes(t))).toEqual(
      [],
    );
  });

  it("真实迁移:重建敏感表的都先删光、后建回触发器", () => {
    expect(
      rebuildViolations(env.TEST_MIGRATIONS, REBUILD_SENSITIVE_TABLES, triggerNames()),
    ).toEqual([]);
  });

  describe("检查器本身", () => {
    const base: D1Migration = {
      name: "0010_user_data_version.sql",
      queries: createDataVersionTriggers(),
    };
    const rebuild = (table: string) => [
      `CREATE TABLE \`__new_${table}\` (\`id\` text PRIMARY KEY NOT NULL)`,
      `INSERT INTO \`__new_${table}\`("id") SELECT "id" FROM \`${table}\``,
      `DROP TABLE \`${table}\``,
      `ALTER TABLE \`__new_${table}\` RENAME TO \`${table}\``,
    ];
    const check = (...later: D1Migration[]) =>
      rebuildViolations([base, ...later], REBUILD_SENSITIVE_TABLES, triggerNames());

    it("drizzle 原样生成的重建(没管触发器)→ 红", () => {
      const v = check({ name: "0011_x.sql", queries: rebuild("accounts") });
      expect(v.length).toBe(triggerNames().length * 2);
      expect(v[0]).toContain("accounts");
    });

    it("开头贴 drop 段、末尾贴 create 段 → 绿", () => {
      const queries = [
        ...dropDataVersionTriggers(),
        ...rebuild("accounts"),
        ...createDataVersionTriggers(),
      ];
      expect(check({ name: "0011_x.sql", queries })).toEqual([]);
    });

    it("建回写在重建之前(顺序错)→ 红", () => {
      const queries = [
        ...dropDataVersionTriggers(),
        ...createDataVersionTriggers(),
        ...rebuild("user"),
      ];
      expect(check({ name: "0011_x.sql", queries }).some((s) => s.includes("末尾没建回"))).toBe(
        true,
      );
    });

    it("重建与触发器无关的表 → 不管", () => {
      expect(check({ name: "0011_x.sql", queries: rebuild("sync_rounds") })).toEqual([]);
    });
  });
});
