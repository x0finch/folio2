import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// Scheduled-task constraints are config that nothing else verifies. Two crons firing in the same minute
// each start a scheduled call and enqueue work, and only show up in production some day at 23:00.
// server.ts branches on `controller.cron === DAILY_CRON`, so the daily expression must match verbatim.
const WRANGLER = join(import.meta.dirname, "../wrangler.jsonc");
const SERVER = join(import.meta.dirname, "../src/server.ts");
const REF_INDEX_WORKFLOW = join(
  import.meta.dirname,
  "../../../.github/workflows/ref-index-refresh.yml",
);

function crons(): string[] {
  const text = readFileSync(WRANGLER, "utf8");
  const line = text.match(/"crons"\s*:\s*\[([^\]]*)\]/);
  if (!line) throw new Error("triggers.crons not found in wrangler.jsonc");
  return [...line[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]);
}

// "minute hour" → every (hour, minute) the expression fires in a day. Supports only the forms used here:
// a number, `*`, and `*/n`.
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

describe("scheduled tasks", () => {
  it("exactly two: daily enqueue + full sweep", () => {
    expect(crons()).toHaveLength(2);
  });

  it("the two never fire in the same minute — a clash means two concurrent enqueues", () => {
    const [a, b] = crons().map(fireTimes);
    const overlap = a.filter((t) => b.includes(t));
    expect(overlap, `both fire at: ${overlap.join(", ")}`).toEqual([]);
  });

  it("sweep runs hourly — 24h P&L cut density depends on it", () => {
    // The daily one fires once a day; the other is the sweep.
    const sweep = crons().find((c) => fireTimes(c).length > 1);
    expect(sweep, "high-frequency cron not found").toBeDefined();
    expect(fireTimes(sweep as string)).toHaveLength(24);
  });

  it("daily expression matches the server.ts constant verbatim — otherwise daily work runs as a sweep", () => {
    const daily = crons().find((c) => fireTimes(c).length === 1);
    const server = readFileSync(SERVER, "utf8");
    const declared = server.match(/DAILY_CRON\s*=\s*"([^"]+)"/);
    expect(declared?.[1]).toBe(daily);
  });
});

// The workflow that refreshes the global ref index lives outside wrangler.jsonc. Without its schedule,
// manual trigger, script or deploy token the index silently stops updating (new tokens go unrecognized).
describe("global ref index refresh (GitHub Actions)", () => {
  const workflow = () => readFileSync(REF_INDEX_WORKFLOW, "utf8");

  it("runs daily on a schedule and can be triggered manually", () => {
    const text = workflow();
    const schedule = text.match(/-\s*cron:\s*"([^"]+)"/);
    expect(schedule, "schedule.cron not found").not.toBeNull();
    expect(fireTimes((schedule as RegExpMatchArray)[1])).toHaveLength(1);
    expect(text).toMatch(/^\s*workflow_dispatch:/m);
  });

  it("runs ref-index:refresh with a token from a repo secret", () => {
    const text = workflow();
    expect(text).toContain("ref-index:refresh");
    expect(text).toContain("secrets.CLOUDFLARE_API_TOKEN");
  });
});

describe("self-test: cron expansion", () => {
  it("half past every hour → 24 times; on the hour → 1", () => {
    expect(fireTimes("30 * * * *")).toHaveLength(24);
    expect(fireTimes("0 23 * * *")).toEqual(["23:0"]);
  });

  it("both on the hour → clash — exactly the pattern to block", () => {
    const a = fireTimes("0 23 * * *");
    const b = fireTimes("0 * * * *");
    expect(a.filter((t) => b.includes(t))).toEqual(["23:0"]);
  });
});
