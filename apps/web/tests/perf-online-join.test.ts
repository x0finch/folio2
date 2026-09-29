import { describe, expect, it } from "vitest";
import { cpuByName, handlerOf, jobKindOf, type LogEvent } from "../scripts/perf/online-join";

// perf:cpu:online 按 requestId 把「带名字的日志行」与「带 cpuTimeMs 的调用事件」对上(review #16/#17)。

const logLine = (requestId: string, message: string, properties: Record<string, unknown>) =>
  ({ $metadata: { requestId, message }, source: { properties } }) satisfies LogEvent;
const invocation = (requestId: string, cpuTimeMs: number, outcome = "ok") =>
  ({ $metadata: { requestId }, $workers: { cpuTimeMs, outcome } }) satisfies LogEvent;

describe("cpuByName — 队列按任务种类", () => {
  const named = [
    logLine("r1", "job done", { kind: "prices", messageId: "m1" }),
    logLine("r2", "job done", { kind: "prices", messageId: "m2" }),
    logLine("r3", "job failed, will retry", { kind: "fx", messageId: "m3" }),
    logLine("r4", "job done", { kind: "sync-account", messageId: "m4" }),
    // 不是任务收尾那一行 → 不认名字
    logLine("r5", "invalid job dropped", { messageId: "m5" }),
  ];
  const invocations = [
    invocation("r1", 4),
    invocation("r2", 12, "exceededCpu"),
    invocation("r3", 7),
    invocation("r4", 30),
    invocation("r5", 1),
    invocation("r9", 50, "exceededCpu"), // 被掐断,来不及打 job done
  ];

  it("同 requestId 对上,按 kind 出 n / 分位 / max / exceededCpu", () => {
    const { rows, unmatched } = cpuByName(named, invocations, jobKindOf);
    expect(unmatched).toBe(2);
    expect(rows.map((r) => r.name)).toEqual(["sync-account", "prices", "fx"]); // p50 降序
    const prices = rows.find((r) => r.name === "prices");
    expect(prices).toMatchObject({ n: 2, p50: 8, max: 12, exceeded: 1 });
    expect(prices?.p99).toBeCloseTo(11.92);
    expect(rows.find((r) => r.name === "fx")).toMatchObject({ n: 1, p50: 7, p99: 7, max: 7 });
  });

  it("jobKindOf 只认 `job …` 开头的行", () => {
    expect(jobKindOf(logLine("x", "job done", { kind: "fx" }))).toBe("fx");
    expect(jobKindOf(logLine("x", "server fn", { kind: "fx" }))).toBeUndefined();
    expect(jobKindOf(logLine("x", "job done", {}))).toBeUndefined();
  });
});

describe("cpuByName — server fn(P99)", () => {
  it("一个 handler 的 100 个样本:p50 / p90 / p99 / max", () => {
    const named = Array.from({ length: 100 }, (_, i) =>
      logLine(`r${i}`, "server fn", { handler: "getSnapshots", durationMs: 1 }),
    );
    const invocations = Array.from({ length: 100 }, (_, i) => invocation(`r${i}`, i + 1));
    const { rows, unmatched } = cpuByName(named, invocations, handlerOf);
    expect(unmatched).toBe(0);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ name: "getSnapshots", n: 100, max: 100 });
    expect(rows[0].p50).toBeCloseTo(50.5);
    expect(rows[0].p90).toBeCloseTo(90.1);
    expect(rows[0].p99).toBeCloseTo(99.01);
  });

  it("同一个 requestId 多行名字取第一行;缺 cpuTimeMs 的调用算没对上", () => {
    const named = [
      logLine("r1", "server fn", { handler: "a" }),
      logLine("r1", "server fn", { handler: "b" }),
    ];
    const { rows, unmatched } = cpuByName(
      named,
      [invocation("r1", 3), { $metadata: { requestId: "r1" }, $workers: {} }],
      handlerOf,
    );
    expect(rows.map((r) => [r.name, r.n])).toEqual([["a", 1]]);
    expect(unmatched).toBe(1);
  });
});
