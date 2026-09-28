import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// 两个定时任务的约束(ADR 0022 / #199 / #446 / FOL-85)。它们是**配置**,没有别的地方会验 ——
// 而配置写错的代价很实:两条撞在同一分钟触发,Workers 各起一次 scheduled 调用、各自投一遍队列,
// 而且只会在生产的某一天 23:00 才表现出来。
//
// `src/server.ts` 的分支是**字符串比对** `controller.cron === DAILY_CRON`,
// 所以每天那条表达式在两个文件里必须逐字一致 —— 改一处忘另一处,每天的活会被当成 sweep 跑。
//
// 全局映射表**不在这两条里刷了**(FOL-85,ADR 0056):它在 GitHub Actions 里跑,约束在文件末尾那组。

const WRANGLER = join(import.meta.dirname, "../wrangler.jsonc");
const SERVER = join(import.meta.dirname, "../src/server.ts");
const REF_INDEX_WORKFLOW = join(
  import.meta.dirname,
  "../../../.github/workflows/ref-index-refresh.yml",
);

function crons(): string[] {
  const text = readFileSync(WRANGLER, "utf8");
  const line = text.match(/"crons"\s*:\s*\[([^\]]*)\]/);
  if (!line) throw new Error("wrangler.jsonc 里找不到 triggers.crons");
  return [...line[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]);
}

// 「分 时」两段 → 该表达式在一天里会触发的所有 (时, 分)。只支持这里用到的形态:
// 具体数字、`*`,以及 `*/n`。
function fireTimes(expr: string): string[] {
  const [min, hour] = expr.split(" ");
  const expand = (field: string, max: number): number[] => {
    if (field === "*") return Array.from({ length: max }, (_, i) => i);
    if (field.startsWith("*/")) {
      const step = Number(field.slice(2));
      return Array.from({ length: max }, (_, i) => i).filter((i) => i % step === 0);
    }
    return field.split(",").map(Number);
  };
  const out: string[] = [];
  for (const h of expand(hour, 24)) {
    for (const m of expand(min, 60)) out.push(`${h}:${m}`);
  }
  return out;
}

describe("定时任务", () => {
  it("恰好两条:每天投活 + 全量 sweep", () => {
    expect(crons()).toHaveLength(2);
  });

  it("**两条永远不在同一分钟触发** —— 撞上就是两次调用并发投活", () => {
    const [a, b] = crons().map(fireTimes);
    const overlap = a.filter((t) => b.includes(t));
    expect(overlap, `这些时刻两条会同时触发: ${overlap.join(", ")}`).toEqual([]);
  });

  it("sweep 每小时一次(#446)—— 24h 盈亏的切口密度靠它", () => {
    // 每天那条一天一次;另一条就是 sweep。
    const sweep = crons().find((c) => fireTimes(c).length > 1);
    expect(sweep, "找不到高频那条").toBeDefined();
    expect(fireTimes(sweep as string)).toHaveLength(24);
  });

  it("每天那条表达式与 server.ts 里的常量逐字一致 —— 不一致会让每天的活被当成 sweep 跑", () => {
    const daily = crons().find((c) => fireTimes(c).length === 1);
    const server = readFileSync(SERVER, "utf8");
    const declared = server.match(/DAILY_CRON\s*=\s*"([^"]+)"/);
    expect(declared?.[1]).toBe(daily);
  });
});

// 刷全局映射表那个 workflow(FOL-85)。它不在 wrangler.jsonc 里,所以另起一组看住:定时 + 手动两个入口
// 都在、跑的是那个脚本、用的是部署那把 token —— 少了任何一样,表就静默地不再更新(新币认不出来,
// 而没有任何报错)。
describe("刷全局映射表(GitHub Actions)", () => {
  const workflow = () => readFileSync(REF_INDEX_WORKFLOW, "utf8");

  it("每天定时一次,也能手动触发", () => {
    const text = workflow();
    const schedule = text.match(/-\s*cron:\s*"([^"]+)"/);
    expect(schedule, "找不到 schedule.cron").not.toBeNull();
    expect(fireTimes((schedule as RegExpMatchArray)[1])).toHaveLength(1);
    expect(text).toMatch(/^\s*workflow_dispatch:/m);
  });

  it("跑的是 ref-index:refresh,token 来自仓库 secret", () => {
    const text = workflow();
    expect(text).toContain("ref-index:refresh");
    expect(text).toContain("secrets.CLOUDFLARE_API_TOKEN");
  });
});

describe("自测:cron 展开", () => {
  it("每小时半点 → 24 个时刻,整点那条 → 1 个", () => {
    expect(fireTimes("30 * * * *")).toHaveLength(24);
    expect(fireTimes("0 23 * * *")).toEqual(["23:0"]);
  });

  it("同为整点就会撞上 —— 这正是要挡的那种写法", () => {
    const a = fireTimes("0 23 * * *");
    const b = fireTimes("0 * * * *");
    expect(a.filter((t) => b.includes(t))).toEqual(["23:0"]);
  });
});
