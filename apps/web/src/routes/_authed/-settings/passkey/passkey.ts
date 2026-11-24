export interface PasskeyRow {
  id: string; // better-auth row id; rename/delete take this
  credentialID: string; // WebAuthn credential id; the device marker stores this. Don't mix them up.
  name?: string | null;
  createdAt: string | Date; // may be a string after fetch deserialization
  aaguid?: string | null;
  backedUp?: boolean | null;
  transports?: string | null;
}

export function errorCode(err: unknown): string | undefined {
  return err && typeof err === "object" && "code" in err ? String(err.code) : undefined;
}

/**
 * Adding a passkey needs a fresh session (better-auth freshAge = 1 day) while sessions last 7 days.
 * Don't disable the check: it stops a stolen session from silently planting a passkey. Re-verify
 * instead; verification skips freshness and rebuilds the session.
 */
export const SESSION_NOT_FRESH = "SESSION_NOT_FRESH";
