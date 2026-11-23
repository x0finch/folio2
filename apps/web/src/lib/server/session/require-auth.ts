import { getLogger, withContext } from "@logtape/logtape";
import { createMiddleware } from "@tanstack/react-start";
import { getRequestHeaders } from "@tanstack/react-start/server";
import { Cause, Runtime } from "effect";
import { resolveAuth } from "./auth-session";
import { getSessionAuth } from "./session-auth";

const log = getLogger(["folio", "web", "server-fn"]);

// Server function guard: resolves the session and injects userId downstream. Session lookup runs inside
// `.server()` so the client bundle drops it. Every fn touching private data must use it (route guards are UX only).
// `withContext({userId})` tags all downstream logs with userId; uncaught handler errors are logged here with it,
// since TanStack otherwise only serializes them to the client.
export const requireAuth = createMiddleware({ type: "function" }).server(async ({ next }) => {
  const auth = resolveAuth(await getSessionAuth().api.getSession({ headers: getRequestHeaders() }));
  return withContext({ userId: auth.userId }, async () => {
    try {
      return await next({ context: auth });
    } catch (err) {
      log.error("server fn threw", {
        error: describe(err),
        code: (err as { code?: string })?.code,
      });
      throw err;
    }
  });
});

// The fallback log must show which handler failed and where: `runEffect` throws a `FiberFailure` whose `message`
// is only the outermost line, while handler names and the call chain live in its `Cause`. So log `Cause.pretty`
// for a FiberFailure (keeps `at createTabPin (...)`), message otherwise.
const describe = (err: unknown): string => {
  if (Runtime.isFiberFailure(err)) return Cause.pretty(err[Runtime.FiberFailureCauseId]);
  return err instanceof Error ? err.message : String(err);
};
