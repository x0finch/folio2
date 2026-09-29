#!/usr/bin/env node
// 一次开页发多少个请求:冷开(新浏览器上下文)与「数据没变时刷新」各一次,按类数 `/_serverFn/*` 与
// `/api/*`(logo 单列)。免费计划按请求数(每天 10 万)与每请求 CPU 计,所以请求条数本身就是一项成本。
//
//   node scripts/perf/requests.mjs              # 构建 → 灌数据 → 冷开 + 刷新
//   node scripts/perf/requests.mjs --no-build
//
// 与 perf:cpu 同一个 worker(构建产物 + wrangler dev + 专用 perf 库 + 假上游),浏览器是 Playwright 的
// Chromium(`PLAYWRIGHT_BROWSERS_PATH`)。数到「网络静下来」为止(networkidle 之后再等一段安静)。
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

/** networkidle 之后再等这么久没有新请求,才算这一页加载完(React Query 的后续查询会晚一拍)。 */
const QUIET_MS = 3_000;
const NAV_TIMEOUT_MS = 60_000;
/** 一直有请求(轮询)也不等过这么久 —— 轮询的那几条记在 `trailing` 里。 */
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

/**
 * 从现在起数这一页的请求,直到网络静下来。数的是**真到了服务端的**那些:在浏览器上下文上听(页面
 * 与 service worker 自己发的都在),由 SW 缓存答的(`fromServiceWorker()`)不算 —— 它们没进 Worker。
 */
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
    // `response()` 偶发不回(实测卡过几分钟)—— 限时,超时按「没响应」算(即不是 SW 缓存答的)。
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

/**
 * 服务端那一侧的计数:wrangler dev 给每个进来的请求打一行 `GET <path> <status>`。浏览器 HTTP 缓存 /
 * SW 缓存答掉的请求不会出现在这里,所以这是「真进了 Worker 的」条数,浏览器那边的计数只作对照。
 */
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
