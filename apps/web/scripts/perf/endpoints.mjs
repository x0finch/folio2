// Endpoints under test: document GETs plus server fns picked by handler name.
//
// Server fn URLs are `/_serverFn/<64-hex id>`; the id is a build artefact that may change per build, so it's looked up by function name in the built resolver manifest, not hardcoded. Request shape follows @tanstack/start-client-core's serverFnFetcher (GET `?payload=<seroval JSON>`) with `Sec-Fetch-Site: same-origin`: Start's CSRF middleware 403s without it (or a same-origin Origin).
import { readdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { DAY_MS, DIST_SERVER_DIR, HOUR_MS, WEB_ROOT } from "./constants.mjs";

// The payload must be encoded with the build's own seroval (other versions may not decode). Resolved down the dependency chain (react-start, start-client-core, seroval) instead of installing a separate copy in @folio/web, which would drift from the server's version.
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

/** Handler name in the build to server fn id. */
export function serverFnIds() {
  const file = readdirSync(ASSETS_DIR).find((f) => f.startsWith(RESOLVER_PREFIX));
  if (!file) throw new Error(`no server-fn resolver manifest in ${ASSETS_DIR} — build first`);
  const src = readFileSync(join(ASSETS_DIR, file), "utf8");
  return new Map([...src.matchAll(MANIFEST_ENTRY)].map((m) => [m[2], m[1]]));
}

// Params for the 24h-gain "previous window" read, same convention as core/portfolio.
const GAIN_WINDOW_MS = DAY_MS;
const GAIN_START_FLOOR_MS = 7 * DAY_MS;
const floorToHour = (t) => Math.floor(t / HOUR_MS) * HOUR_MS;

/** Endpoint definition. `fn` = a server fn by handler name (GET read paths only); `path` = a document / plain route. `authed` defaults to true. `expect` = response status; a mismatch is flagged in the report, since a 401 profile measures the error path, not the endpoint. */
const ENDPOINTS = [
  // After shelling, documents are static assets and navigation doesn't enter the Worker: these two rows are the "should be 0 CPU" control.
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
  // Control: static assets don't enter the worker (run_worker_first excludes them), so the profiler should report ~0; anything else means the measurement is broken.
  {
    key: "static-favicon",
    label: "GET /favicon.ico (control)",
    path: "/favicon.ico",
    authed: false,
  },
];

export const ENDPOINT_KEYS = ENDPOINTS.map((e) => e.key);

/** Instantiates the list into sendable requests. ctx = { origin, cookie, portfolioId, platforms, now }. `only`, when given, keeps just those names (validated by cpu.mjs before work starts). */
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
