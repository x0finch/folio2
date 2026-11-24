import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const WRANGLER = join(import.meta.dirname, "../wrangler.jsonc");

const readConfig = () => {
  const text = readFileSync(WRANGLER, "utf8")
    .split("\n")
    .map((line) => line.replace(/(^|[^:"])\/\/.*$/, "$1"))
    .join("\n")
    .replace(/,(\s*[}\]])/g, "$1");
  return JSON.parse(text) as Env & {
    migrations?: { tag: string; new_sqlite_classes?: string[]; new_classes?: string[] }[];
    env: Record<string, Env & { triggers?: unknown }>;
  };
};

interface Env {
  durable_objects?: { bindings: { name: string; class_name: string }[] };
  queues?: unknown;
}

const all = () => {
  const cfg = readConfig();
  return [["top-level", cfg] as const, ...Object.entries(cfg.env)] as const;
};

describe("runner config", () => {
  it.each(all())("%s: has a JOB_RUNNER binding pointing at JobRunner", (_name, env) => {
    const binding = env.durable_objects?.bindings.find((b) => b.name === "JOB_RUNNER");
    expect(binding?.class_name).toBe("JobRunner");
  });

  it.each(all())("%s: has no queue config", (_name, env) => {
    expect(env.queues).toBeUndefined();
  });

  it("JobRunner is created in migrations with SQLite storage (the free plan only allows SQLite DOs)", () => {
    const migrations = readConfig().migrations ?? [];
    expect(migrations.some((m) => m.new_sqlite_classes?.includes("JobRunner"))).toBe(true);
    expect(migrations.some((m) => m.new_classes?.includes("JobRunner"))).toBe(false);
  });

  it("preview has no cron: the runner there only takes manually enqueued jobs", () => {
    expect(readConfig().env.preview?.triggers).toBeUndefined();
  });
});
