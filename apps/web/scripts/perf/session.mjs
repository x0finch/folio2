// Perf user login via better-auth's HTTP API, the same path as real browsers and e2e (fixtures/app.ts).
//
// `Origin` is required (better-auth's CSRF check 403s without it). The cookie comes straight from the `Set-Cookie` header (`getSetCookie()`), not curl's cookie jar: its `#HttpOnly_` lines look like comments and get filtered, silently dropping the session (every request 401s).
import { PERF_USER } from "./constants.mjs";
import { findUserId, seedDataset } from "./dataset.mjs";
import { devVar, originOf, startWorker } from "./worker.mjs";

/** Set-Cookie list to the request `cookie` header (name=value only, attributes dropped). */
function cookieHeaderOf(res) {
  return res.headers
    .getSetCookie()
    .map((c) => c.split(";")[0])
    .join("; ");
}

async function post(origin, path, body) {
  return fetch(`${origin}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", origin },
    body: JSON.stringify(body),
  });
}

/** Registers the perf user (better-auth has autoSignIn, so registering logs in). */
async function signUp(origin, user) {
  const res = await post(origin, "/api/auth/sign-up/email", user);
  if (!res.ok) throw new Error(`sign-up failed: ${res.status} ${await res.text()}`);
  return cookieHeaderOf(res);
}

/** Logs in and returns the `cookie` request header value. */
export async function signIn(origin, { email, password }) {
  const res = await post(origin, "/api/auth/sign-in/email", { email, password });
  if (!res.ok) throw new Error(`sign-in failed: ${res.status} ${await res.text()}`);
  const cookie = cookieHeaderOf(res);
  if (!cookie) throw new Error("sign-in returned no session cookie");
  return cookie;
}

/** Ensures the perf user exists with freshly seeded data; returns { userId, counts }. Seeding writes SQLite directly, so the worker must be stopped: a first-time registration starts it, registers, stops, then seeds. */
export async function prepareData({ seed, dataset, port, workerOpts, log }) {
  let userId = findUserId(PERF_USER.email);
  if (!userId) {
    log(`registering ${PERF_USER.email}`);
    const w = await startWorker(workerOpts);
    try {
      await signUp(originOf(port), PERF_USER);
    } finally {
      await w.stop();
    }
    userId = findUserId(PERF_USER.email);
    if (!userId) throw new Error("sign-up succeeded but the user row is not in the perf DB");
  }
  if (!seed) return { userId, counts: null };
  const counts = seedDataset({ userId, ...dataset, secretsKey: devVar("SECRETS_KEY") });
  log(`seeded ${JSON.stringify(counts)}`);
  return { userId, counts };
}
