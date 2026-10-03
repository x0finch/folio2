import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// 后台任务运行器的配置约束(FOL-100,ADR 0058)。它们是**配置**,没有别的地方会验:
//   · 每个 env 都得有自己的 `JOB_RUNNER` 绑定 —— `durable_objects` 在 env 里不继承,少一份那个环境
//     投活时就是 `env.JOB_RUNNER` 为 undefined,cron 与手动同步一起哑掉;
//   · 绑定的类必须在迁移里以 **SQLite 存储**建出来 —— 免费计划只能用 SQLite 的 DO,而运行器的活表
//     本来就在 `ctx.storage.sql` 里;
//   · 队列那一套(FOL-86)整块退场,别留一份没人消费的 `queues` 配置,部署时还要求先建队列。

const WRANGLER = join(import.meta.dirname, "../wrangler.jsonc");

// 去掉 `//` 行注释再当 JSON 读。只处理这份文件用到的形态:注释独占一行或跟在值后面,
// 字符串里没有 `//`(URL 在注释里,不在值里)。
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

describe("运行器配置", () => {
  it.each(all())("%s:有 JOB_RUNNER 绑定,指向 JobRunner", (_name, env) => {
    const binding = env.durable_objects?.bindings.find((b) => b.name === "JOB_RUNNER");
    expect(binding?.class_name).toBe("JobRunner");
  });

  it.each(all())("%s:不再有队列配置", (_name, env) => {
    expect(env.queues).toBeUndefined();
  });

  it("JobRunner 在迁移里以 SQLite 存储建出(免费计划只能用 SQLite 的 DO)", () => {
    const migrations = readConfig().migrations ?? [];
    expect(migrations.some((m) => m.new_sqlite_classes?.includes("JobRunner"))).toBe(true);
    expect(migrations.some((m) => m.new_classes?.includes("JobRunner"))).toBe(false);
  });

  it("preview 没有 cron —— 运行器在那里只接手动投的活", () => {
    expect(readConfig().env.preview?.triggers).toBeUndefined();
  });
});
