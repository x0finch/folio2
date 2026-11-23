import { betterAuth } from "better-auth";
import { tanstackStartCookies } from "better-auth/tanstack-start";
import { sharedAuthOptions } from "./auth-options";

// Session-only instance used by `requireAuth`, authed route handlers and `getSession`. Not the full instance:
// importing its passkey plugin costs ~12 ms CPU on the first request of every cold isolate (free plan: 10 ms),
// and session checks don't need it. Shares `sharedAuthOptions()` so both sign sessions identically; singletons are built once per isolate.
function createSessionAuth() {
  return betterAuth({
    ...sharedAuthOptions(),
    plugins: [tanstackStartCookies()], // session renewal / cookie-cache refresh must write Set-Cookie
  });
}

let instance: ReturnType<typeof createSessionAuth> | null = null;

export function getSessionAuth() {
  instance ??= createSessionAuth();
  return instance;
}
