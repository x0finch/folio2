// 被测端点清单:文档 GET + 按 handler 名点的 server fn。
//
// server fn 的 URL 是 `/_serverFn/<64 位 hex id>`,id 是构建产物,每次构建可能变 —— 从构建出的
// resolver manifest 里按函数名反查,不写死。请求形状照抄 @tanstack/start-client-core 的
// serverFnFetcher(GET:`?payload=<seroval JSON>`),并带 `Sec-Fetch-Site: same-origin`
// —— Start 的 CSRF 中间件不见它(或同源 Origin)就回 403。
import { readdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { DAY_MS, DIST_SERVER_DIR, HOUR_MS, WEB_ROOT } from "./constants.mjs";

/**
 * payload 用 seroval 编 —— 必须是**构建里那一份** seroval,两边版本不同就可能解不开。
 * 沿依赖链取(react-start → start-client-core → seroval),而不是在 @folio/web 里另装一份:
 * 另装的那份会跟着自己的版本号走,迟早和服务端的对不上。
 */
function loadSeroval() {
  const fromWeb = createRequire(join(WEB_ROOT, "package.json"));
  const fromStart = createRequire(fromWeb.resolve("@tanstack/react-start/package.json"));
  const fromClientCore = createRequire(
    fromStart.resolve("@tanstack/start-client-core/package.json"),
  );
  return fromClientCore(fromClientCore.resolve("seroval"));
}

const ASSETS_DIR = join(DIST_SERVER_DIR, "assets");
const RESOLVER_PREFIX = "__23tanstack-start-server-fn-resolver-";
const MANIFEST_ENTRY =
  /"([0-9a-f]{64})":\s*\{\s*functionName: "([A-Za-z0-9_$]+)_createServerFn_handler"/g;

/** 构建产物里的 handler 名 → server fn id。 */
export function serverFnIds() {
  const file = readdirSync(ASSETS_DIR).find((f) => f.startsWith(RESOLVER_PREFIX));
  if (!file) throw new Error(`no server-fn resolver manifest in ${ASSETS_DIR} — build first`);
  const src = readFileSync(join(ASSETS_DIR, file), "utf8");
  return new Map([...src.matchAll(MANIFEST_ENTRY)].map((m) => [m[2], m[1]]));
}

// 24h 盈亏的「上一窗口」取数参数,与 core/portfolio 同口径。
const GAIN_WINDOW_MS = DAY_MS;
const GAIN_START_FLOOR_MS = 7 * DAY_MS;
const floorToHour = (t) => Math.floor(t / HOUR_MS) * HOUR_MS;

/**
 * 端点定义。`fn` = 按 handler 名点 server fn(只列 GET 的读路径);`path` = 文档 / 普通路由。
 * `authed` 默认真。`expect` = 应答状态,对不上就在报表里标出来 —— 一个 401 的 profile 量的是
 * 报错路径,不是这个端点。
 */
const ENDPOINTS = [
  // 壳化(ADR 0049 补记)之后文档是静态资源,导航不进 Worker:这两行是「应为 0 CPU」的对照组。
  { key: "doc-root-authed", label: "GET / (static shell, authed)", path: "/", doc: true },
  {
    key: "doc-root-anon",
    label: "GET / (static shell, no cookie)",
    path: "/",
    doc: true,
    authed: false,
  },
  { key: "doc-login", label: "GET /login", path: "/login", doc: true, authed: false },
  { key: "auth-get-session", label: "GET /api/auth/get-session", path: "/api/auth/get-session" },
  { key: "fn-getSession", fn: "getSession" },
  { key: "fn-getValuationSettings", fn: "getValuationSettings" },
  { key: "fn-getDataVersion", fn: "getDataVersion" },
  { key: "fn-listPortfolios", fn: "listPortfolios" },
  { key: "fn-listAccounts", fn: "listAccounts", data: ({ portfolioId }) => ({ portfolioId }) },
  {
    key: "fn-getSnapshots-now",
    fn: "getSnapshots",
    data: ({ portfolioId, now }) => ({ portfolioId, at: now }),
  },
  {
    key: "fn-getSnapshots-prev",
    fn: "getSnapshots",
    data: ({ portfolioId, now }) => ({
      portfolioId,
      at: floorToHour(now) - GAIN_WINDOW_MS,
      after: floorToHour(now) - GAIN_START_FLOOR_MS,
    }),
  },
  { key: "fn-getTokenEnrichment", fn: "getTokenEnrichment" },
  { key: "fn-getFiatRefs", fn: "getFiatRefs", data: ({ portfolioId }) => ({ portfolioId }) },
  {
    key: "fn-resolvePlatformMeta",
    fn: "resolvePlatformMeta",
    data: ({ platforms }) => ({ chainIds: platforms }),
  },
  {
    key: "fn-getPortfolioHistory-30d",
    fn: "getPortfolioHistory",
    data: ({ portfolioId }) => ({ portfolioId, range: "30d" }),
  },
  {
    key: "fn-getPortfolioHistory-1y",
    fn: "getPortfolioHistory",
    data: ({ portfolioId }) => ({ portfolioId, range: "1y" }),
  },
  { key: "fn-listConnectors", fn: "listConnectors" },
  { key: "fn-getSyncRound", fn: "getSyncRound", data: ({ portfolioId }) => ({ portfolioId }) },
  {
    key: "fn-getPortfolioTabPins",
    fn: "getPortfolioTabPins",
    data: ({ portfolioId }) => ({ portfolioId }),
  },
  { key: "fn-listTags", fn: "listTags", data: ({ portfolioId }) => ({ portfolioId }) },
  {
    key: "fn-listAccountTags",
    fn: "listAccountTags",
    data: ({ portfolioId }) => ({ portfolioId }),
  },
  // 对照组:静态资源不进 worker(run_worker_first 不含它),profiler 应该报 ≈0。不是 0 就是量法坏了。
  {
    key: "static-favicon",
    label: "GET /favicon.ico (control)",
    path: "/favicon.ico",
    authed: false,
  },
];

export const ENDPOINT_KEYS = ENDPOINTS.map((e) => e.key);

/**
 * 把清单实例化成可发的请求。ctx = { origin, cookie, portfolioId, platforms, now }。
 * `only` 给了就只要那几个(名字由 cpu.mjs 在开工前校验过)。
 */
export async function buildEndpoints(ctx, only) {
  const picked = only ? ENDPOINTS.filter((e) => only.includes(e.key)) : ENDPOINTS;
  const ids = serverFnIds();
  const seroval = picked.some((e) => e.data) ? loadSeroval() : undefined;

  return Promise.all(
    picked.map(async (e) => {
      const authed = e.authed ?? true;
      const headers = { ...(authed ? { cookie: ctx.cookie } : {}) };
      const base = { key: e.key, label: e.label ?? `server fn ${e.fn}`, expect: e.expect ?? 200 };
      if (!e.fn) {
        const docHeaders = e.doc ? { "sec-fetch-mode": "navigate", accept: "text/html" } : {};
        return {
          ...base,
          url: `${ctx.origin}${e.path}`,
          init: { headers: { ...headers, ...docHeaders } },
        };
      }
      const id = ids.get(e.fn);
      if (!id) throw new Error(`server fn "${e.fn}" not in the build manifest (renamed?)`);
      let url = `${ctx.origin}/_serverFn/${id}`;
      if (e.data) {
        const payload = JSON.stringify(await seroval.toJSONAsync({ data: e.data(ctx) }));
        url += `?${new URLSearchParams({ payload })}`;
      }
      return {
        ...base,
        url,
        init: {
          headers: {
            ...headers,
            "x-tsr-serverFn": "true",
            accept: "application/x-tss-framed, application/x-ndjson, application/json",
            "sec-fetch-site": "same-origin",
            origin: ctx.origin,
          },
        },
      };
    }),
  );
}
