#!/usr/bin/env node
// Requests per page open: a cold open (fresh browser context) and a refresh with unchanged data, counted by kind (`/_serverFn/*` and `/api/*`, logos separate). The free plan bills per request (100k a day) and per-request CPU, so the request count is itself a cost.
//
//   node scripts/perf/requests.mjs              # build, seed, cold open + refresh
//   node scripts/perf/requests.mjs --no-build
//
// Same worker as perf:cpu (build output + wrangler dev + dedicated perf DB + fake upstream); the browser is Playwright's Chromium (`PLAYWRIGHT_BROWSERS_PATH`). Counts until the network goes quiet (networkidle, then a further quiet period).
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { chromium } from "@playwright/test";
import {
  DEFAULT_ACCOUNTS,
  DEFAULT_DAYS,
  DEFAULT_FAKE_UPSTREAM_PORT,
  DEFAULT_INSPECTOR_PORT,
  DEFAULT_PORT,
  DEFAULT_TOKENS,
  PERF_STATE_DIR,
  PERF_USER,
} from "./constants.mjs";
import { serverFnIds } from "./endpoints.mjs";
import { startFakeUpstream } from "./fake-upstream.mjs";
import { prepareData, signIn } from "./session.mjs";
import { build, checkDevVars, migrate, originOf, startWorker, stopAll } from "./worker.mjs";

/** Extra quiet time after networkidle before the page counts as loaded (React Query's follow-up queries arrive a beat late). */
const QUIET_MS = 3_000;
const NAV_TIMEOUT_MS = 60_000;
/** Upper bound even when requests keep coming (polling); the polling ones are recorded in `trailing`. */
const MAX_SETTLE_MS = 20_000;
const RESPONSE_WAIT_MS = 2_000;

const log = (msg) => process.stderr.write(`[perf:requests] ${msg}\n`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function categorize(url, fnNames) {
  const { pathname } = new URL(url);
  if (pathname.startsWith("/_serverFn/")) {
    const id = pathname.slice("/_serverFn/".length).split("/")[0];
    return { cat: "serverFn", name: fnNames.get(id) ?? id.slice(0, 8) };
  }
  if (pathname.startsWith("/api/logo/")) return { cat: "api-logo", name: pathname.split("/")[3] };
  if (pathname.startsWith("/api/")) return { cat: "api", name: pathname };
  return { cat: "other", name: pathname };
}

// Counts this page's requests from now until the network is quiet: only those that really reached the server, listened to on the browser context (page and service worker traffic both); SW-cache answers (`fromServiceWorker()`) don't count since they never hit the Worker.
async function countLoad(context, page, origin, fnNames, navigate) {
  const finished = [];
  let last = Date.now();
  const trailing = [];
  let idle = false;
  const onRequest = (req) => {
    last = Date.now();
    if (idle) trailing.push(new URL(req.url()).pathname);
  };
  const onDone = (req) => {
    if (new URL(req.url()).origin === origin) finished.push(req);
    last = Date.now();
  };
  const navigations = [];
  const onNav = (frame) => {
    if (frame === page.mainFrame()) navigations.push(frame.url());
  };
  context.on("request", onRequest);
  context.on("requestfinished", onDone);
  context.on("requestfailed", onDone);
  page.on("framenavigated", onNav);
  await navigate();
  await page.waitForLoadState("networkidle", { timeout: NAV_TIMEOUT_MS });
  idle = true;
  const until = Date.now() + MAX_SETTLE_MS;
  while (Date.now() - last < QUIET_MS && Date.now() < until) await sleep(200);
  context.off("request", onRequest);
  context.off("requestfinished", onDone);
  context.off("requestfailed", onDone);
  page.off("framenavigated", onNav);
  const counts = { serverFn: 0, api: 0, "api-logo": 0, other: 0, fromSwCache: 0 };
  const byName = {};
  for (const req of finished) {
    // `response()` sometimes never returns (stuck for minutes in practice): time-box it; a timeout counts as "no response" (not a SW-cache answer).
    const res = await Promise.race([req.response().catch(() => null), sleep(RESPONSE_WAIT_MS)]);
    if (res?.fromServiceWorker()) {
      counts.fromSwCache++;
      continue;
    }
    const s = categorize(req.url(), fnNames);
    counts[s.cat]++;
    const k = `${s.cat} ${s.name}`;
    byName[k] = (byName[k] ?? 0) + 1;
  }
  return { url: page.url(), navigations, counts, byName, trailing };
}

// Server-side count: wrangler dev logs one `GET <path> <status>` per incoming request. Browser-HTTP-cache / SW-cache answers don't appear, so this is the count that truly reached the Worker; the browser-side count is only a cross-check.
function serverSideCounts(logFile, from) {
  const text = readFileSync(logFile, "utf8").slice(from).replace(ANSI, "");
  const counts = { serverFn: 0, api: 0, "api-logo": 0 };
  for (const m of text.matchAll(/\[wrangler:info\] (?:GET|POST) (\S+) \d{3}/g)) {
    const path = m[1];
    if (path.startsWith("/_serverFn/")) counts.serverFn++;
    else if (path.startsWith("/api/logo/")) counts["api-logo"]++;
    else if (path.startsWith("/api/")) counts.api++;
  }
  return counts;
}
const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g");
const logSize = (file) => readFileSync(file, "utf8").length;

async function main() {
  const { values } = parseArgs({
    options: {
      "no-build": { type: "boolean", default: false },
      "no-seed": { type: "boolean", default: false },
      path: { type: "string", default: "/" },
    },
  });
  checkDevVars();
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const out = join(PERF_STATE_DIR, "runs", `requests-${stamp}`);
  mkdirSync(out, { recursive: true });
  const logFile = join(out, "wrangler.log");
  writeFileSync(logFile, "");
  if (!values["no-build"]) {
    log("building (vite build)");
    build(logFile);
  }
  migrate(logFile);
  const fake = await startFakeUpstream({ port: DEFAULT_FAKE_UPSTREAM_PORT });
  const workerOpts = {
    port: DEFAULT_PORT,
    inspectorPort: DEFAULT_INSPECTOR_PORT,
    logFile,
    vars: fake.vars,
  };
  const dataset = { accounts: DEFAULT_ACCOUNTS, tokens: DEFAULT_TOKENS, days: DEFAULT_DAYS };
  let browser;
  try {
    await prepareData({ seed: !values["no-seed"], dataset, port: DEFAULT_PORT, workerOpts, log });
    const origin = originOf(DEFAULT_PORT);
    const w = await startWorker(workerOpts);
    try {
      const cookie = await signIn(origin, PERF_USER);
      const fnNames = new Map([...serverFnIds()].map(([name, id]) => [id, name]));
      browser = await chromium.launch();
      const context = await browser.newContext();
      await context.addCookies(
        cookie.split("; ").map((c) => {
          const at = c.indexOf("=");
          return { name: c.slice(0, at), value: c.slice(at + 1), url: origin };
        }),
      );
      const page = await context.newPage();
      const target = `${origin}${values.path}`;
      let from = logSize(logFile);
      const cold = await countLoad(context, page, origin, fnNames, () => page.goto(target));
      cold.server = serverSideCounts(logFile, from);
      from = logSize(logFile);
      const reload = await countLoad(context, page, origin, fnNames, () => page.reload());
      reload.server = serverSideCounts(logFile, from);
      const result = { at: new Date().toISOString(), target, cold, reload };
      writeFileSync(join(out, "summary.json"), `${JSON.stringify(result, null, 2)}\n`);
      console.log(JSON.stringify(result, null, 2));
    } finally {
      await browser?.close();
      await w.stop();
    }
  } finally {
    await fake.close();
  }
}

main()
  .then(() => stopAll())
  .catch(async (err) => {
    console.error(`[perf:requests] ${err instanceof Error ? err.stack : err}`);
    await stopAll();
    process.exit(1);
  });
