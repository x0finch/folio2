// Default for edge caching: a response that doesn't explicitly declare itself cacheable is never cached.
// `wrangler.jsonc` enables `cache` (the logo proxy needs it) and CF's edge cache key is the URL only, not Cookie;
// SSR pages with a logged-in user's holdings and no `cache-control` were cached and served to other users.
// Responses that set their own `cache-control` (logo proxy, static assets) are untouched. Don't flip this to
// cacheable-by-default and patch endpoints one by one: one miss leaks a user's holdings.
const PRIVATE_NO_STORE = "private, no-store";

// `no-store` suffices; `Vary: Cookie` is a second layer in case an intermediary ignores it. Both are sent.
const VARY_COOKIE = "cookie";

const hasVaryCookie = (vary: string | null): boolean =>
  vary?.split(",").some((v) => v.trim().toLowerCase() === VARY_COOKIE || v.trim() === "*") ?? false;

// Adds the default non-cacheable declaration unless `cache-control` is already set.
export function withDefaultNoStore(res: Response): Response {
  // A WebSocket upgrade (101) can't be reconstructed; pass it through.
  if (res.status === 101 || (res as { webSocket?: unknown }).webSocket) return res;
  if (res.headers.has("cache-control")) return res;

  const headers = new Headers(res.headers);
  headers.set("cache-control", PRIVATE_NO_STORE);
  if (!hasVaryCookie(headers.get("vary"))) headers.append("vary", VARY_COOKIE);

  // The body is handed over by reference (ReadableStream), not buffered.
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
}
