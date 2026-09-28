#!/usr/bin/env node
// 线上 CPU:从 Workers Logs 读 Cloudflare 计量的 `cpuTimeMs`(不是响应耗时)。
//
//   pnpm --filter @folio/web perf:cpu:online                    # 当前线上版本,最近 7 天
//   pnpm --filter @folio/web perf:cpu:online --days 1 --version all
//   pnpm --filter @folio/web perf:cpu:online --token-env MY_TOKEN_VAR
//
// 要一把能读 Workers Logs 的账户级 API token(`folio` 这个 Worker 的 Metadata Read-Only 即可),
// 放在环境变量里(默认 CLOUDFLARE_OBSERVABILITY_TOKEN)。token 只进请求头,从不打印。
// 口径与局限见 scripts/perf/README.md 的「线上」一节。
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { DAY_MS, WEB_ROOT } from "./constants.mjs";
import { quantile } from "./report.mjs";

const API = "https://api.cloudflare.com/client/v4";
const DEFAULT_TOKEN_ENV = "CLOUDFLARE_OBSERVABILITY_TOKEN";
const DEFAULT_DAYS = 7;
/** Workers Logs 事件接口一次最多回这么多条(再多它也会按自适应采样截断)。 */
const EVENTS_LIMIT = 2000;
/** 分组统计最多回多少组。 */
const GROUPS_LIMIT = 100;
/** `runtime.ts` 的 `withServerFnTiming` 每个 server fn 打的那行日志:带 `handler`,和调用日志同一个 requestId。 */
const SERVER_FN_MESSAGE = "server fn";
/** 免费档每次调用的 CPU 上限。 */
const BUDGET_MS = 10;

const USAGE = `usage: perf:cpu:online [options]
  --days N          look back N days (default ${DEFAULT_DAYS})
  --version ID      script version id, "latest" (default) or "all"
  --token-env NAME  env var holding the API token (default ${DEFAULT_TOKEN_ENV})`;

/** account_id 与 Worker 名只写在 wrangler.jsonc 里一次,这里照读,不另抄一份。 */
function readWranglerIds() {
  const text = readFileSync(join(WEB_ROOT, "wrangler.jsonc"), "utf8");
  const pick = (key) => text.match(new RegExp(`^\\s*"${key}"\\s*:\\s*"([^"]+)"`, "m"))?.[1];
  const account = pick("account_id");
  const script = pick("name");
  if (!account || !script) throw new Error("account_id / name not found in wrangler.jsonc");
  return { account, script };
}

function parseOptions(argv) {
  const { values } = parseArgs({
    args: argv,
    options: {
      days: { type: "string", default: String(DEFAULT_DAYS) },
      version: { type: "string", default: "latest" },
      "token-env": { type: "string", default: DEFAULT_TOKEN_ENV },
      help: { type: "boolean", short: "h", default: false },
    },
  });
  const days = Number(values.days);
  if (!Number.isFinite(days) || days <= 0) throw new Error("--days must be a positive number");
  return { days, version: values.version, tokenEnv: values["token-env"], help: values.help };
}

function client({ account, token }) {
  const call = async (path, body) => {
    const res = await fetch(`${API}/accounts/${account}${path}`, {
      method: body ? "POST" : "GET",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: body ? JSON.stringify(body) : undefined,
    });
    const json = await res.json();
    if (!json.success) {
      const why = json.errors?.map((e) => `${e.code} ${e.message}`).join("; ") ?? res.status;
      throw new Error(`${path}: ${why}`);
    }
    return json.result;
  };
  return { call };
}

async function latestVersion(api, script) {
  const { deployments } = await api.call(`/workers/scripts/${script}/deployments`);
  const newest = deployments?.[0];
  if (!newest) throw new Error("no deployments found");
  return { id: newest.versions[0].version_id, createdOn: newest.created_on };
}

/** 所有查询共用的时间窗 + 过滤(Worker 名,可选版本)。 */
function scope({ script, version, from, to }) {
  const filters = [{ key: "$metadata.service", operation: "eq", type: "string", value: script }];
  if (version) {
    filters.push({
      key: "$workers.scriptVersion.id",
      operation: "eq",
      type: "string",
      value: version,
    });
  }
  return { timeframe: { from, to }, filters };
}

/**
 * 分组统计 CPU:这部分是全量的,不抽样。**分组键在某条调用上缺失时,那条调用整个不进结果**
 * (fetch 没有 cron),所以「按 cron」只能在只看 scheduled 的那次查询里分。
 */
async function cpuBy(api, sc, groupKeys, extraFilters = []) {
  const cpu = { key: "$workers.cpuTimeMs", keyType: "number" };
  const result = await api.call("/workers/observability/telemetry/query", {
    queryId: "folio-perf-online-invocations",
    timeframe: sc.timeframe,
    view: "calculations",
    limit: GROUPS_LIMIT,
    parameters: {
      datasets: ["cloudflare-workers"],
      filters: [
        ...sc.filters,
        ...extraFilters,
        { key: "$workers.cpuTimeMs", operation: "exists", type: "number" },
      ],
      calculations: [
        { operator: "count", alias: "n" },
        { operator: "median", alias: "p50", ...cpu },
        { operator: "p99", alias: "p99", ...cpu },
        { operator: "max", alias: "max", ...cpu },
      ],
      groupBys: groupKeys.map((value) => ({ type: "string", value })),
    },
  });
  const rows = new Map();
  for (const calc of result.calculations ?? []) {
    for (const agg of calc.aggregates ?? []) {
      const row = rows.get(agg.groupKey) ?? {
        group: agg.groups
          .map((g) => g.value)
          .filter(Boolean)
          .join(" · "),
      };
      row[calc.alias] = agg.value;
      rows.set(agg.groupKey, row);
    }
  }
  return [...rows.values()].sort((a, b) => a.group.localeCompare(b.group));
}

async function events(api, sc, extraFilters) {
  const result = await api.call("/workers/observability/telemetry/query", {
    queryId: "folio-perf-online-events",
    timeframe: sc.timeframe,
    view: "events",
    limit: EVENTS_LIMIT,
    parameters: { datasets: ["cloudflare-workers"], filters: [...sc.filters, ...extraFilters] },
  });
  return result.events?.events ?? [];
}

/**
 * 按 server fn 拆:TanStack 的路径在日志里是 REDACTED,只能把「server fn」那行日志(带 handler)
 * 和同一个 requestId 的调用日志(带 cpuTimeMs)对上。**事件接口是抽样的**,所以这张表给的是
 * 样本内的分布,n 就是样本数。
 */
async function byServerFn(api, sc) {
  const [named, invocations] = await Promise.all([
    events(api, sc, [
      { key: "$metadata.message", operation: "eq", type: "string", value: SERVER_FN_MESSAGE },
    ]),
    events(api, sc, [
      { key: "$metadata.trigger", operation: "includes", type: "string", value: "/_serverFn/" },
      { key: "$workers.cpuTimeMs", operation: "exists", type: "number" },
    ]),
  ]);
  const handlerOf = new Map(
    named.map((e) => [e.$metadata?.requestId, e.source?.properties?.handler]).filter(([, h]) => h),
  );
  const groups = new Map();
  let unmatched = 0;
  for (const e of invocations) {
    const handler = handlerOf.get(e.$metadata?.requestId);
    const cpu = e.$workers?.cpuTimeMs;
    if (!handler || cpu == null) {
      unmatched++;
      continue;
    }
    const g = groups.get(handler) ?? { handler, cpus: [], exceeded: 0 };
    g.cpus.push(cpu);
    if (e.$workers.outcome === "exceededCpu") g.exceeded++;
    groups.set(handler, g);
  }
  const rows = [...groups.values()]
    .map((g) => ({
      handler: g.handler,
      n: g.cpus.length,
      p50: quantile(g.cpus, 0.5),
      p90: quantile(g.cpus, 0.9),
      max: Math.max(...g.cpus),
      exceeded: g.exceeded,
    }))
    .sort((a, b) => b.p50 - a.p50);
  return { rows, unmatched, sampled: invocations.length };
}

const cell = (x) => (x == null ? "—" : typeof x === "number" ? String(Math.round(x)) : String(x));

function table(header, rows) {
  const body = rows.map((r) => r.map(cell));
  const widths = header.map((h, c) => Math.max(h.length, ...body.map((row) => row[c].length)));
  const line = (row) =>
    row.map((v, c) => (c === 0 ? v.padEnd(widths[c]) : v.padStart(widths[c]))).join("  ");
  return [line(header), line(widths.map((w) => "-".repeat(w))), ...body.map(line)].join("\n");
}

async function main() {
  const opts = parseOptions(process.argv.slice(2));
  if (opts.help) {
    console.log(USAGE);
    return;
  }
  const token = process.env[opts.tokenEnv];
  if (!token) throw new Error(`env var ${opts.tokenEnv} is not set (see --token-env)`);
  const { account, script } = readWranglerIds();
  const api = client({ account, token });

  let version;
  let versionNote = "all versions";
  if (opts.version === "latest") {
    const latest = await latestVersion(api, script);
    version = latest.id;
    versionNote = `latest version ${latest.id} (deployed ${latest.createdOn})`;
  } else if (opts.version !== "all") {
    version = opts.version;
    versionNote = `version ${version}`;
  }
  const to = Date.now();
  const sc = scope({ script, version, from: to - opts.days * DAY_MS, to });

  const [invocations, crons, serverFns] = await Promise.all([
    cpuBy(api, sc, ["$workers.eventType", "$workers.outcome"]),
    cpuBy(
      api,
      sc,
      ["$workers.event.cron", "$workers.outcome"],
      [{ key: "$workers.eventType", operation: "eq", type: "string", value: "scheduled" }],
    ),
    byServerFn(api, sc),
  ]);

  console.log(`Workers Logs cpuTimeMs — ${script}, last ${opts.days} day(s), ${versionNote}`);
  console.log(`budget ${BUDGET_MS} ms per invocation (free plan)\n`);
  const cpuHeader = (first) => [first, "n", "p50 ms", "p99 ms", "max ms"];
  const cpuRow = (r) => [r.group, r.n, r.p50, r.p99, r.max];
  console.log("by invocation (full counts)");
  console.log(table(cpuHeader("event · outcome"), invocations.map(cpuRow)));
  console.log("\nscheduled, by cron (full counts)");
  console.log(table(cpuHeader("cron · outcome"), crons.map(cpuRow)));
  console.log(
    `\nby server fn (sampled: ${serverFns.sampled} invocations, ${serverFns.unmatched} unmatched)`,
  );
  console.log(
    table(
      ["handler", "n", "p50 ms", "p90 ms", "max ms", "exceededCpu"],
      serverFns.rows.map((r) => [r.handler, r.n, r.p50, r.p90, r.max, r.exceeded]),
    ),
  );
}

main().catch((err) => {
  console.error(`[perf:online] ${err.message}`);
  process.exit(1);
});
