import { type D1Migration, env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import {
  createDataVersionTriggers,
  dropDataVersionTriggers,
  REBUILD_SENSITIVE_TABLES,
} from "../scripts/data-version-triggers";

// Data-version triggers x table rebuilds. drizzle-kit ignores triggers: rebuilding a trigger-referenced table fails at RENAME and DROP silently drops its triggers.
// Guards: (1) the generator matches the real triggers verbatim; (2) every migration after 0010 that rebuilds/drops a sensitive table drops all triggers first and recreates them at the end.

const TRIGGER_NAME = /^CREATE TRIGGER `([^`]+)`/;
const REBUILT = /ALTER TABLE\s+[`"]?__new_(\w+)[`"]?\s+RENAME TO/i;
const DROPPED = /DROP TABLE\s+(?:IF EXISTS\s+)?[`"]?(\w+)[`"]?/i;

const norm = (sql: string) => sql.trim().replace(/;$/, "").trim();
const triggerNames = () => createDataVersionTriggers().map((s) => TRIGGER_NAME.exec(s)?.[1] ?? "");

// Returns violations; an empty array means all migrations comply.
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
      if (!dropped)
        out.push(`${m.name}: rebuilt/dropped ${tables} but did not drop ${name} at the start`);
      if (!recreated)
        out.push(`${m.name}: rebuilt/dropped ${tables} but did not recreate ${name} at the end`);
    }
  }
  return out;
}

describe("data-version triggers x table rebuilds", () => {
  it("the generator matches the real triggers verbatim", async () => {
    const { results } = await env.DB.prepare(
      "SELECT name, sql FROM sqlite_master WHERE type = 'trigger' AND name LIKE '%\\_data\\_version\\_%' ESCAPE '\\' ORDER BY name",
    ).all<{ name: string; sql: string }>();
    const live = results.map((r) => norm(r.sql)).sort();
    const generated = createDataVersionTriggers().map(norm).sort();
    expect(live).toEqual(generated);
  });

  it("every table the triggers reference is in REBUILD_SENSITIVE_TABLES", () => {
    const referenced = createDataVersionTriggers().flatMap((sql) =>
      [...sql.matchAll(/(?:ON|FROM|INTO)\s+`(\w+)`/g)].map((m) => m[1]),
    );
    expect([...new Set(referenced)].filter((t) => !REBUILD_SENSITIVE_TABLES.includes(t))).toEqual(
      [],
    );
  });

  it("real migrations: those rebuilding sensitive tables drop all triggers first and recreate them last", () => {
    expect(
      rebuildViolations(env.TEST_MIGRATIONS, REBUILD_SENSITIVE_TABLES, triggerNames()),
    ).toEqual([]);
  });

  describe("the checker itself", () => {
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

    it("a drizzle-style rebuild that ignores triggers: red", () => {
      const v = check({ name: "0011_x.sql", queries: rebuild("accounts") });
      expect(v.length).toBe(triggerNames().length * 2);
      expect(v[0]).toContain("accounts");
    });

    it("drop block at the start, create block at the end: green", () => {
      const queries = [
        ...dropDataVersionTriggers(),
        ...rebuild("accounts"),
        ...createDataVersionTriggers(),
      ];
      expect(check({ name: "0011_x.sql", queries })).toEqual([]);
    });

    it("recreate before the rebuild (wrong order): red", () => {
      const queries = [
        ...dropDataVersionTriggers(),
        ...createDataVersionTriggers(),
        ...rebuild("user"),
      ];
      expect(
        check({ name: "0011_x.sql", queries }).some((s) => s.includes("did not recreate")),
      ).toBe(true);
    });

    it("rebuilding a table unrelated to triggers: ignored", () => {
      expect(check({ name: "0011_x.sql", queries: rebuild("sync_rounds") })).toEqual([]);
    });
  });
});
