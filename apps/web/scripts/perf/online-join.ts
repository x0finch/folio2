// Splits perf:cpu:online CPU by name: in Workers Logs, invocation events with `cpuTimeMs` don't know which server fn / background job they were; our own log line under the same requestId does (`server fn` with `handler`, or the consumer's `job done` / `job failed...` with `kind`). This joins the two by requestId and builds per-name distributions. Pure functions; online.mjs fetches and tests/perf-online-join.test.ts pins the logic.
//
// Plain TS with no imports: online.mjs loads it directly via Node 22.18+ type stripping.

/** The fields we use from one event returned by the events API. */
export interface LogEvent {
  $metadata?: { requestId?: string; message?: string };
  $workers?: { cpuTimeMs?: number; outcome?: string };
  source?: { properties?: Record<string, unknown> };
}

interface NamedCpuRow {
  name: string;
  n: number;
  p50: number;
  p90: number;
  p99: number;
  max: number;
  exceeded: number;
}

export interface NamedCpu {
  rows: NamedCpuRow[];
  /** Invocation events without a matching name (the name line wasn't sampled, or the invocation was cut off: exceededCpu leaves no time to log). */
  unmatched: number;
}

/** Same convention as report.mjs's `quantile` (sorted, linear interpolation). */
function quantile(sorted: readonly number[], q: number): number {
  const i = (sorted.length - 1) * q;
  const lo = Math.floor(i);
  const hi = Math.ceil(i);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (i - lo);
}

/** `named`: log events with a name (`nameOf` extracts it; none means the event doesn't count). `invocations`: events with `cpuTimeMs`; with several name lines for one requestId the first wins. */
export function cpuByName(
  named: readonly LogEvent[],
  invocations: readonly LogEvent[],
  nameOf: (e: LogEvent) => string | undefined,
): NamedCpu {
  const nameByRequest = new Map<string, string>();
  for (const e of named) {
    const id = e.$metadata?.requestId;
    const name = nameOf(e);
    if (id && name && !nameByRequest.has(id)) nameByRequest.set(id, name);
  }
  const groups = new Map<string, { cpus: number[]; exceeded: number }>();
  let unmatched = 0;
  for (const e of invocations) {
    const id = e.$metadata?.requestId;
    const name = id ? nameByRequest.get(id) : undefined;
    const cpu = e.$workers?.cpuTimeMs;
    if (!name || cpu == null) {
      unmatched++;
      continue;
    }
    const g = groups.get(name) ?? { cpus: [], exceeded: 0 };
    g.cpus.push(cpu);
    if (e.$workers?.outcome === "exceededCpu") g.exceeded++;
    groups.set(name, g);
  }
  const rows = [...groups].map(([name, g]) => {
    const s = [...g.cpus].sort((a, b) => a - b);
    return {
      name,
      n: s.length,
      p50: quantile(s, 0.5),
      p90: quantile(s, 0.9),
      p99: quantile(s, 0.99),
      max: s[s.length - 1],
      exceeded: g.exceeded,
    };
  });
  return { rows: rows.sort((a, b) => b.p50 - a.p50), unmatched };
}

const stringProp = (e: LogEvent, key: string): string | undefined => {
  const v = e.source?.properties?.[key];
  return typeof v === "string" && v ? v : undefined;
};

/** The `server fn` line from `withServerFnTiming` (runtime.ts) to the handler name. */
export const handlerOf = (e: LogEvent) => stringProp(e, "handler");

/** The consumer's (jobs/consume.ts) `job done` / `job failed...` lines to the job kind; the runner's own `job buried...` carries no kind and doesn't count. */
export const jobKindOf = (e: LogEvent) =>
  e.$metadata?.message?.startsWith("job ") ? stringProp(e, "kind") : undefined;
