import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// 两个定时任务的约束(ADR 0022 / #199 / #446)。它们是**配置**,没有别的地方会验 ——
// 而配置写错的代价很实:两个重活撞在同一分钟触发,Workers 各起一次 scheduled 调用,
// 正是当初拆成两个 trigger 想避开的事,而且只会在生产的某一天 23:00 才表现出来。
//
// `src/server.ts` 的分支是**字符串比对** `controller.cron === GLOBAL_REF_INDEX_CRON`,
// 所以刷表那条表达式在两个文件里必须逐字一致 —— 改一处忘另一处,刷表会被当成 sweep 跑。

const WRANGLER = join(import.meta.dirname, "../wrangler.jsonc");
const SERVER = join(import.meta.dirname, "../src/server.ts");

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
  it("恰好两条:刷映射表 + 全量 sweep", () => {
    expect(crons()).toHaveLength(2);
  });

  it("**两条永远不在同一分钟触发** —— 撞上就是两个重活并发", () => {
    const [a, b] = crons().map(fireTimes);
    const overlap = a.filter((t) => b.includes(t));
    expect(overlap, `这些时刻两条会同时触发: ${overlap.join(", ")}`).toEqual([]);
  });

  it("sweep 每小时一次(#446)—— 24h 盈亏的切口密度靠它", () => {
    // 刷表那条是每天一次;另一条就是 sweep。
    const sweep = crons().find((c) => fireTimes(c).length > 1);
    expect(sweep, "找不到高频那条").toBeDefined();
    expect(fireTimes(sweep as string)).toHaveLength(24);
  });

  it("刷表那条落在 sweep 之前的那半小时里 —— 当天就能用上新映射", () => {
    const refresh = crons().find((c) => fireTimes(c).length === 1) as string;
    const sweep = crons().find((c) => fireTimes(c).length > 1) as string;
    const [refreshMin] = refresh.split(" ").map(Number);
    const [sweepMin] = sweep.split(" ").map(Number);
    // 刷表在整点、sweep 在半点 → 刷完半小时后那次 sweep 就带上新数据
    expect(sweepMin).toBeGreaterThan(refreshMin);
  });

  it("刷表那条表达式与 server.ts 里的常量逐字一致 —— 不一致会让刷表被当成 sweep 跑", () => {
    const refresh = crons().find((c) => fireTimes(c).length === 1);
    const server = readFileSync(SERVER, "utf8");
    const declared = server.match(/GLOBAL_REF_INDEX_CRON\s*=\s*"([^"]+)"/);
    expect(declared?.[1]).toBe(refresh);
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
