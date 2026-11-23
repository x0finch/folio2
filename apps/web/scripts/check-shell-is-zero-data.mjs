// The prerendered document shell must carry zero data. `dist/client/index.html` is a public file served to everyone from Workers Static Assets (edge-cacheable, bypassing the Worker's `no-store` path) and is baked from a real Worker request to `/` on the build machine, so anything the root route computes server-side lands in it (build time, build locale and login DOM once did). The shell contents are an allowlist: anything extra fails. Widening it is a deliberate edit together with the justification below.
// Runs after `vite build` in apps/web's `build` script (so CI's `pnpm build` and deploy both run it).

import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createContext, runInContext } from "node:vm";

const HERE = dirname(fileURLToPath(import.meta.url));
const CLIENT_DIR = join(HERE, "..", "dist", "client");

/** The required shell: if missing, prerender didn't run and "nothing to check" must not pass as clean. */
const REQUIRED_SHELLS = ["index.html"];

/** Non-prerendered HTML in `dist/client`: the hand-written PWA offline page in public/, which has no SSR payload. */
const NOT_PRERENDERED = new Set(["offline.html"]);

// All data allowed in the shell; each entry must answer "why may this go to everyone".

/** Top-level fields of the decoded router state: `manifest` (build asset names, public), `matches` (route ids; fields below), `lastMatchId`, and `dehydratedData` (query channel, must be empty). */
const ALLOWED_ROUTER_KEYS = new Set(["manifest", "matches", "lastMatchId", "dehydratedData"]);

/**
 * Fields allowed per match (router-core `dehydrateMatch` shorthand): `i` match id, `u` updatedAt (the build timestamp, the same for everyone; the browser reloads after hydration), `s` status, `ssr`.
 * Not allowed: `l` (loaderData), `b` (beforeLoad context), `e` (error, may carry server details), `g` (global not-found; a shell rendered as 404 is broken).
 */
const ALLOWED_MATCH_KEYS = new Set(["i", "u", "s", "ssr"]);

/** Allowed `dehydratedData` fields: only the `queryStream` pipe itself, and it must carry nothing. `dehydratedQueryClient` present means a query was read on the build machine. */
const ALLOWED_DEHYDRATED_KEYS = new Set(["queryStream"]);

// Scan only decoded data (matches + dehydratedData + stream queries), not the whole HTML or manifest: preload lists hold file names like `-accounts-*.js`, which would always false-positive.
//
// `session` is on the list (a session token is the worst leak). False positives would need a legitimate data string containing the word, and under the allowlist the data holds only route ids / timestamps / status; a hit is a real leak or a route id containing it, so edit here with a reason. Case-insensitive.
const FORBIDDEN_IN_DATA = [
  "userId",
  "user_id",
  "accountId",
  "account_id",
  "enc_credentials",
  "credentials",
  "session",
];

// Email shapes are scanned across the whole HTML: the shell has no legitimate reason to contain one, and user names/emails are the first SSR leak to appear.
const EMAIL_SHAPED = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/;

/** The inline script carrying the SSR payload; it hangs the whole router state on `$_TSR.router`. */
const PAYLOAD_MARKER = "$_TSR.router";

/** Inline scripts of TanStack's serialisation stream (payload plus later push/close chunks such as `$R[19].return(void 0)`); theme / locale / style injection scripts don't carry these markers and aren't run. */
const STREAM_MARKERS = ["$_TSR", "$R["];

/** Wait cap for reading the query stream: everything in it is pushed synchronously by those scripts, so not finishing means the closing script is gone. */
const STREAM_DRAIN_TIMEOUT_MS = 1000;

function streamScriptsOf(html) {
  const scripts = [];
  for (const match of html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)) {
    const body = match[1];
    if (STREAM_MARKERS.some((marker) => body.includes(marker))) scripts.push(body);
  }
  return scripts;
}

/** Runs the scripts in a sandbox in document order and reads the result instead of regexing it: the payload is seroval-serialised JS (cross-referencing, real functions and ReadableStream) and the gate's value is missing nothing. It's our own build output, not external input. */
function routerStateOf(scripts) {
  // `self` must be the global object itself: the payload writes `self.$_TSR = ...` then reads bare `$_TSR` (in browsers `self === globalThis`).
  const sandbox = { ReadableStream, document: { currentScript: { remove() {} } } };
  sandbox.self = sandbox;
  sandbox.globalThis = sandbox;
  createContext(sandbox);
  for (const script of scripts) runInContext(script, sandbox);
  return sandbox.$_TSR?.router;
}

/** Drains the query stream; returns null if it never closes (unfinished is not the same as empty). */
async function drain(stream) {
  const reader = stream.getReader();
  const chunks = [];
  // Don't unref the timer: with an unclosed stream it's all that's left in the event loop, and unref would make node exit (code 13) instead of reaching the readable error below.
  let timer;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve(null), STREAM_DRAIN_TIMEOUT_MS);
  });
  try {
    for (;;) {
      const next = await Promise.race([reader.read(), timeout]);
      if (next === null) return null;
      if (next.done) return chunks;
      chunks.push(next.value);
    }
  } finally {
    clearTimeout(timer);
  }
}

function checkRouterKeys(router, fail) {
  for (const key of Object.keys(router)) {
    if (!ALLOWED_ROUTER_KEYS.has(key))
      fail(`router state has an extra top-level field ${JSON.stringify(key)}`);
  }
}

function checkMatches(matches, fail) {
  if (!Array.isArray(matches) || matches.length === 0) {
    fail(
      "router state has no matches: the payload shape changed and this gate may be broken; inspect the build output",
    );
    return;
  }
  for (const match of matches) {
    for (const key of Object.keys(match)) {
      if (!ALLOWED_MATCH_KEYS.has(key)) {
        fail(
          `match ${JSON.stringify(match.i)} has an extra field ${JSON.stringify(key)} (allowlist: ${[...ALLOWED_MATCH_KEYS]})`,
        );
      }
    }
    if (!Number.isFinite(match.u)) {
      fail(`match ${JSON.stringify(match.i)} has a non-timestamp u: ${JSON.stringify(match.u)}`);
    }
  }
}

function describeState(state) {
  const queries = (state?.queries ?? []).map((q) => q.queryHash);
  return `${queries.length} queries ${JSON.stringify(queries)}, ${state?.mutations?.length ?? 0} mutations`;
}

async function checkDehydrated(dehydrated, fail) {
  if (dehydrated === undefined) return [];
  for (const key of Object.keys(dehydrated)) {
    if (!ALLOWED_DEHYDRATED_KEYS.has(key)) {
      const detail = key === "dehydratedQueryClient" ? `:${describeState(dehydrated[key])}` : "";
      fail(`dehydratedData has an extra field ${JSON.stringify(key)}${detail}`);
    }
  }
  const stream = dehydrated.queryStream;
  if (!(stream instanceof ReadableStream)) {
    fail(
      "dehydratedData.queryStream is not a stream: the payload shape changed and this gate may be broken; inspect the build output",
    );
    return [];
  }
  const chunks = await drain(stream);
  if (chunks === null) {
    fail(
      `query stream did not close within ${STREAM_DRAIN_TIMEOUT_MS}ms: is the closing script gone? Cannot confirm it is empty`,
    );
    return [];
  }
  for (const chunk of chunks) fail(`query stream pushed data: ${describeState(chunk)}`);
  return chunks;
}

function checkForbiddenWords(router, streamed, fail) {
  const { queryStream: _stream, ...dehydratedRest } = router.dehydratedData ?? {};
  const data = JSON.stringify({
    matches: router.matches ?? null,
    lastMatchId: router.lastMatchId ?? null,
    dehydrated: dehydratedRest,
    streamed,
  }).toLowerCase();
  for (const word of FORBIDDEN_IN_DATA) {
    if (data.includes(word.toLowerCase()))
      fail(`forbidden word ${JSON.stringify(word)} in the shell's data block`);
  }
}

async function checkFile(name) {
  const problems = [];
  const fail = (message) => problems.push(message);
  const html = readFileSync(join(CLIENT_DIR, name), "utf8");

  const email = html.match(EMAIL_SHAPED);
  if (email) fail(`email-shaped string in the HTML: ${email[0]}`);

  const scripts = streamScriptsOf(html);
  if (!scripts.some((script) => script.includes(PAYLOAD_MARKER))) {
    // A missing payload must not pass as clean: TanStack likely changed its injection shape and the gate would idle.
    fail(
      `SSR payload script not found (marker: ${PAYLOAD_MARKER}); this gate may be broken, inspect the build output`,
    );
    return problems;
  }

  let router;
  try {
    router = routerStateOf(scripts);
  } catch (error) {
    fail(`SSR payload script failed to run, cannot decode: ${String(error)}`);
    return problems;
  }
  if (!router) return [...problems, "the SSR payload ran but produced no $_TSR.router"];

  checkRouterKeys(router, fail);
  checkMatches(router.matches, fail);
  const streamed = await checkDehydrated(router.dehydratedData, fail);
  checkForbiddenWords(router, streamed, fail);
  return problems;
}

let htmlFiles;
try {
  htmlFiles = readdirSync(CLIENT_DIR).filter((name) => name.endsWith(".html"));
} catch {
  console.error(`[shell-gate] cannot read ${CLIENT_DIR}: did vite build fail?`);
  process.exit(1);
}

let failed = false;
for (const name of REQUIRED_SHELLS) {
  if (htmlFiles.includes(name)) continue;
  failed = true;
  console.error(`[shell-gate] dist/client/${name} does not exist: did prerender not run?`);
}

const shells = htmlFiles.filter((name) => !NOT_PRERENDERED.has(name));
for (const name of shells) {
  const problems = await checkFile(name);
  if (problems.length === 0) continue;
  failed = true;
  for (const problem of problems) console.error(`[shell-gate] ${name}: ${problem}`);
}

if (failed) {
  console.error(
    "[shell-gate] The prerendered document shell is public and edge-cacheable and must carry zero data. " +
      "To allow something new, edit the allowlist in scripts/check-shell-is-zero-data.mjs and state why it is public.",
  );
  process.exit(1);
}

console.log(
  `[shell-gate] ${shells.length} prerendered document shell(s) (${shells.join(", ")}), zero data ✓`,
);
