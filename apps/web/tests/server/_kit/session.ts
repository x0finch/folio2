import { env } from "cloudflare:test";
import { getSessionAuth } from "@/lib/server/session/session-auth";

// Route handlers authenticate via better-auth `getSession` with no swappable service, so sign up a
// real user and use its Set-Cookie. The test Worker only binds DB, so the auth env vars (a fake,
// test-only secret) are set before the lazy instance is first built. Goes through `.handler(Request)`
// because `api.signUpEmail` makes `tanstackStartCookies` import a request context absent here.

const ORIGIN = "http://localhost:3000";

const ensureAuthEnv = () => {
  const e = env as unknown as Record<string, string | undefined>;
  e.BETTER_AUTH_URL ??= ORIGIN;
  e.BETTER_AUTH_SECRET ??= "test-only-better-auth-secret-0123456789abcdef";
};

export interface SignedIn {
  readonly userId: string;
  readonly cookie: string;
}

/** Deletes any prior user with the same email (cascading their data), signs up, returns the cookie. */
export const signUp = async (email: string): Promise<SignedIn> => {
  ensureAuthEnv();
  await env.DB.prepare("DELETE FROM user WHERE email = ?").bind(email).run();
  const res = await getSessionAuth().handler(
    new Request(`${ORIGIN}/api/auth/sign-up/email`, {
      method: "POST",
      headers: { origin: ORIGIN, "content-type": "application/json" },
      body: JSON.stringify({ email, password: "test-password-123", name: email }),
    }),
  );
  if (!res.ok) throw new Error(`sign-up failed: ${res.status} ${await res.text()}`);
  const body = (await res.json()) as { user: { id: string } };
  const cookie = res.headers
    .getSetCookie()
    .map((c) => c.split(";")[0])
    .join("; ");
  return { userId: body.user.id, cookie };
};

export const appRequest = (path: string, init: RequestInit = {}, as?: SignedIn): Request => {
  ensureAuthEnv();
  const headers = new Headers(init.headers);
  if (as) headers.set("cookie", as.cookie);
  return new Request(`${ORIGIN}${path}`, { ...init, headers });
};
