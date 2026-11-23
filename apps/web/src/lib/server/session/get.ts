import { getRequestHeaders } from "@tanstack/react-start/server";
import { getSessionAuth } from "./session-auth";

// Public (non-authed): returns the user or null. Only for route-guard UX; the security boundary is each
// authed server fn throwing 401.
export async function handleGetSession() {
  const result = await getSessionAuth().api.getSession({ headers: getRequestHeaders() });
  return result ? { user: result.user } : null;
}
