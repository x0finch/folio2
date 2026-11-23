import { env } from "cloudflare:workers";
import { passkey } from "@better-auth/passkey";
import { betterAuth } from "better-auth";
import { tanstackStartCookies } from "better-auth/tanstack-start";
import { sharedAuthOptions } from "./auth-options";
import { derivePasskeyRp } from "./passkey-rp";

// Full instance (login, signup, passkey ceremonies), imported on demand by the `/api/auth/*` route only: a static
// import would put the passkey code (asn1 / WebAuthn) back into every cold request (tests/auth-split.test.ts).

function createAuth() {
  // WebAuthn RP derives from BETTER_AUTH_URL (rpID = host), so credentials registered on localhost don't work
  // on a tunnel domain and vice versa.
  const rp = derivePasskeyRp(env.BETTER_AUTH_URL);
  return betterAuth({
    ...sharedAuthOptions(),
    plugins: [
      passkey({
        rpID: rp.rpID,
        rpName: rp.rpName,
        origin: rp.origin,
        // userVerification "required": every ceremony needs biometrics/PIN as proof of presence; the plugin default
        // "preferred" lets the platform skip it. residentKey stays "preferred": conditional UI needs discoverable
        // credentials, but "required" would exclude some authenticators.
        authenticatorSelection: { residentKey: "preferred", userVerification: "required" },
      }),
      tanstackStartCookies(), // must be last in the plugins array
    ],
  });
}

let authInstance: ReturnType<typeof createAuth> | null = null;

// Lazy singleton: built on first request, never at module load; `env` comes from cloudflare:workers to avoid
// creating several drizzle instances per request.
export function getAuth() {
  authInstance ??= createAuth();
  return authInstance;
}
