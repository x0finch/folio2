import { env } from "cloudflare:workers";
import { createAuthAdapter } from "@folio/db";
import type { BetterAuthOptions } from "better-auth";

// Shared by the full auth instance (`auth.ts`) and the session-only one (`session-auth.ts`): session signing,
// cookie name and lifetime must match exactly. Only `plugins` differ; never import passkey here.

// Equals better-auth's default; see `cookieCache` below.
const SESSION_COOKIE_CACHE_MAX_AGE_S = 5 * 60;

export function sharedAuthOptions() {
  // Extra trusted origins, set only in preview envs (PREVIEW_TRUSTED_ORIGINS), empty in production. Lets per-PR
  // workers.dev aliases pass Origin/CSRF (password login only: passkey rpID stays bound to BETTER_AUTH_URL).
  const previewTrustedOrigins = (env.PREVIEW_TRUSTED_ORIGINS ?? "")
    .split(",")
    .map((o) => o.trim())
    .filter(Boolean);
  return {
    baseURL: env.BETTER_AUTH_URL,
    secret: env.BETTER_AUTH_SECRET,
    trustedOrigins: previewTrustedOrigins,
    database: createAuthAdapter(env),
    emailAndPassword: {
      enabled: true,
      requireEmailVerification: false, // no email verification when self-hosted
      autoSignIn: true,
    },
    session: {
      expiresIn: 60 * 60 * 24 * 7, // 7d
      updateAge: 60 * 60 * 24, // 1d
      // cookieCache on: a signed `session_data` cookie hit skips the D1 session SELECT on every server fn
      // (free plan: 10 ms CPU). Cost: a session revoked elsewhere stays valid here for up to maxAge; sign-out clears
      // the cookie. If a path needing immediate revocation appears, pass `query: { disableCookieCache: true }` to
      // `getSession`. Re-check this if secondaryStorage is ever configured (upstream cookieCache bug).
      cookieCache: { enabled: true, maxAge: SESSION_COOKIE_CACHE_MAX_AGE_S },
    },
  } satisfies BetterAuthOptions;
}
