// perf:cpu:online 的「按名字拆 CPU」:Workers Logs 里,带 `cpuTimeMs` 的调用事件不知道自己是哪个
// server fn / 哪件后台活;知道名字的是**同一个 requestId** 下我们自己打的那行日志
// (`server fn` 带 `handler`,运行器 alarm 里 consumer 打的 `job done` / `job failed…` 带 `kind`)。这里把两边按
// requestId 对上,再按名字出分布。纯函数,online.mjs 取数、tests/perf-online-join.test.ts 钉逻辑。
//
// 纯 TS、无 import:online.mjs 经 Node 22.18+ 的类型擦除直接加载它。

/** 事件接口回来的一条事件里我们用得到的那几个字段。 */
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
  /** 调用事件里对不上名字的条数(名字那行没被抽中,或调用被掐断 —— exceededCpu 时来不及打日志)。 */
  unmatched: number;
}

/** 与 report.mjs 的 `quantile` 同一个口径(排序后线性插值)。 */
function quantile(sorted: readonly number[], q: number): number {
  const i = (sorted.length - 1) * q;
  const lo = Math.floor(i);
  const hi = Math.ceil(i);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (i - lo);
}

/**
 * `named`:带名字的日志事件;`nameOf` 从一条里取名字(取不到 → 这条不算)。
 * `invocations`:带 `cpuTimeMs` 的调用事件。同一个 requestId 有多行名字时取第一行。
 */
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

/** `withServerFnTiming`(runtime.ts)打的 `server fn` 行 → handler 名。 */
export const handlerOf = (e: LogEvent) => stringProp(e, "handler");

/** consumer(jobs/consume.ts)的 `job done` / `job failed…` 行 → 任务种类。运行器自己的 `job buried…` 不带 kind,不算。 */
export const jobKindOf = (e: LogEvent) =>
  e.$metadata?.message?.startsWith("job ") ? stringProp(e, "kind") : undefined;
