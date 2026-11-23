import { resolveAuth } from "./auth-session";
import { getSessionAuth } from "./session-auth";

// Gets the current user in route handlers (server fns use `requireAuth`, which can't attach to
// `createFileRoute(...).server.handlers`). userId comes only from a verified session. No session returns
// undefined, so logo endpoints can't tell "not logged in" from "not yours".
export async function userIdOf(request: Request): Promise<string | undefined> {
  const result = await getSessionAuth().api.getSession({ headers: request.headers });
  return result?.user.id;
}

// For endpoints that require login: no session gives a 401 Response (same shape as resolveAuth).
export async function requireUserId(request: Request): Promise<string | Response> {
  const session = await getSessionAuth().api.getSession({ headers: request.headers });
  try {
    return resolveAuth(session).userId;
  } catch (err) {
    return err instanceof Response ? err : new Response("Unauthorized", { status: 401 });
  }
}
