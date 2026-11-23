// Pure auth logic with no server-only imports, so unit tests can import it and the client bundle stays clean.

export interface SessionResult {
  user: { id: string; [k: string]: unknown };
  session: { id: string; [k: string]: unknown };
}

// userId comes only from a verified session, never from client input; no session throws a 401 Response.
// Returns only userId: handlers don't receive `context`; `getSession` (session/get.ts) is the public route for user details.
export function resolveAuth(result: SessionResult | null): { userId: string } {
  if (!result) {
    throw new Response("Unauthorized", { status: 401 });
  }
  return { userId: result.user.id };
}
