// Fake Binance for e2e: lets the sync path run end to end and produce snapshots offline.
// Why: of the 9 connectors only manual stays offline and manual is excluded from sync; the other 8 call external APIs, and running e2e against real
// providers would bind CI to third-party availability, against this suite's anti-flaky rule (a retried pass doesn't count).
// Only two endpoints are needed: a Binance account's wallets are best-effort, so a wallet that can't be fetched doesn't block the rest (it becomes an account-level Note);
// spot + a price table is enough for a snapshot, and futures / funding / earn return empty structures.
// No signature check: the provider sends an HMAC and this just replies; e2e wants "does the path work", not "is the signature right" (unit-tested).
// How it's pointed at: `.dev.vars.test` sets BINANCE_{API,FAPI,DAPI}_BASE to this process, the provider-creds override production also uses (proxying when the egress IP is refused).
// Who starts it: playwright.config.ts's webServer (`node e2e/fixtures/binance-server.mjs`), so it's its own process entry with no import pointing at it;
// knip.json lists it under `entry` rather than `ignore`, so dead code inside it is still checked.

import { createServer } from "node:http";

const PORT = Number(process.env.FAKE_BINANCE_PORT ?? 3099);
const COINGECKO_PREFIX = "/coingecko/api/v3";

// -- mutable state, changed via /__control --
// One process plays two upstreams in a run: fast when adding accounts (credential validation shouldn't wait) and slow when measuring the "close the tab" case.
// spotBtc matters most: the "round finished after the tab closed" assertion relies on the balance having been changed before clicking sync, so a new number read later can only
// come from a fetch after closing; a constant fixed at startup can't do that. hits is an increase-only counter used as a guardrail: locally `reuseExistingServer` may reuse a plain
// `pnpm dev` server (without CLOUDFLARE_ENV=test) that talks to real Binance, and the failure ("binance auth failed") wouldn't show the environment wasn't switched; counting
// requests makes it obvious. Tests can POST hits:0 to reset.
const state = { delayMs: 0, spotBtc: "1.50000000", btcPrice: "60000.00", hits: 0 };
const NUMERIC_KEYS = new Set(["delayMs", "hits"]);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const routes = () => ({
  // Spot: one BTC holding, asserted in the snapshot; the quantity is changeable.
  "/api/v3/account": { balances: [{ asset: "BTC", free: state.spotBtc, locked: "0.00000000" }] },
  // Price table: spot valuation needs it.
  "/api/v3/ticker/price": [
    { symbol: "BTCUSDT", price: state.btcPrice },
    { symbol: "ETHUSDT", price: "3000.00" },
  ],
  // Other wallets return empty: a valid structure is enough, the provider parses 0 rows.
  "/fapi/v2/account": { totalWalletBalance: "0", assets: [], positions: [] },
  "/dapi/v1/account": { assets: [], positions: [] },
  "/sapi/v1/asset/get-funding-asset": [],
  "/sapi/v1/simple-earn/flexible/position": { rows: [], total: 0 },
  "/sapi/v1/simple-earn/locked/position": { rows: [], total: 0 },
});

const json = (res, status, body) => {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
};

const readJsonBody = async (req) => {
  let raw = "";
  for await (const chunk of req) raw += chunk;
  return raw ? JSON.parse(raw) : {};
};

createServer(async (req, res) => {
  const path = new URL(req.url, `http://localhost:${PORT}`).pathname;

  // Playwright's webServer probes this to tell whether it's up.
  if (path === "/ping") {
    res.writeHead(200, { "content-type": "text/plain" });
    res.end("ok");
    return;
  }

  // Control endpoint: GET reads current state, POST changes it. Only known keys are accepted: a misspelled key must fail on the spot,
  // not silently do nothing (which would make a test look like it tests slow sync while delay was always 0).
  if (path === "/__control") {
    if (req.method === "POST") {
      const patch = await readJsonBody(req);
      for (const [key, value] of Object.entries(patch)) {
        if (!(key in state)) return json(res, 400, { error: `unknown control key: ${key}` });
        state[key] = NUMERIC_KEYS.has(key) ? Number(value) : String(value);
      }
    }
    return json(res, 200, state);
  }

  // Fake CoinGecko: `.dev.vars.test`'s `COINGECKO_API_BASE` points at `/coingecko/api/v3`. It only needs to be fast: local Miniflare consumes the queue serially, and real-CoinGecko
  // price jobs (rejected + retried in e2e, ~12s each) would block ahead of the sync message so "click sync -> upstream gets a request within 15s" times out. Empty results
  // make the reference layer degrade as "not refreshed" and e2e doesn't verify prices. Doesn't count hits or honor delayMs: those serve the Binance path.
  if (path.startsWith(COINGECKO_PREFIX)) {
    const rest = path.slice(COINGECKO_PREFIX.length);
    return json(res, 200, rest.startsWith("/coins") || rest === "/asset_platforms" ? [] : {});
  }

  state.hits += 1;
  if (state.delayMs > 0) await sleep(state.delayMs);
  const body = routes()[path];
  if (body === undefined) {
    return json(res, 404, { code: -1121, msg: `fake-binance: no route ${path}` });
  }
  return json(res, 200, body);
}).listen(PORT, () => {
  console.log(`fake-binance listening on ${PORT}`);
});
