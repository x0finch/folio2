import { describe, expect, it } from "vitest";
import { cpuByName, handlerOf, jobKindOf, type LogEvent } from "../scripts/perf/online-join";

// perf:cpu:online joins named log lines with cpuTimeMs invocation events by requestId.

const logLine = (requestId: string, message: string, properties: Record<string, unknown>) =>
  ({ $metadata: { requestId, message }, source: { properties } }) satisfies LogEvent;
const invocation = (requestId: string, cpuTimeMs: number, outcome = "ok") =>
  ({ $metadata: { requestId }, $workers: { cpuTimeMs, outcome } }) satisfies LogEvent;

describe("cpuByName — queue by job kind", () => {
  const named = [
    logLine("r1", "job done", { kind: "prices", messageId: "m1" }),
    logLine("r2", "job done", { kind: "prices", messageId: "m2" }),
    logLine("r3", "job failed, will retry", { kind: "fx", messageId: "m3" }),
    logLine("r4", "job done", { kind: "sync-account", messageId: "m4" }),
    // not a job-completion line -> name not recognized
    logLine("r5", "invalid job dropped", { messageId: "m5" }),
  ];
  const invocations = [
    invocation("r1", 4),
    invocation("r2", 12, "exceededCpu"),
    invocation("r3", 7),
    invocation("r4", 30),
    invocation("r5", 1),
    invocation("r9", 50, "exceededCpu"), // cut off before logging job done
  ];

  it("joins on requestId, per kind: n / percentiles / max / exceededCpu", () => {
    const { rows, unmatched } = cpuByName(named, invocations, jobKindOf);
    expect(unmatched).toBe(2);
    expect(rows.map((r) => r.name)).toEqual(["sync-account", "prices", "fx"]); // p50 descending
    const prices = rows.find((r) => r.name === "prices");
    expect(prices).toMatchObject({ n: 2, p50: 8, max: 12, exceeded: 1 });
    expect(prices?.p99).toBeCloseTo(11.92);
    expect(rows.find((r) => r.name === "fx")).toMatchObject({ n: 1, p50: 7, p99: 7, max: 7 });
  });

  it("jobKindOf only accepts lines starting with `job …`", () => {
    expect(jobKindOf(logLine("x", "job done", { kind: "fx" }))).toBe("fx");
    expect(jobKindOf(logLine("x", "server fn", { kind: "fx" }))).toBeUndefined();
    expect(jobKindOf(logLine("x", "job done", {}))).toBeUndefined();
  });
});

describe("cpuByName — server fn(P99)", () => {
  it("100 samples for one handler: p50 / p90 / p99 / max", () => {
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

  it("multiple name lines per requestId take the first; invocations missing cpuTimeMs do not join", () => {
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
