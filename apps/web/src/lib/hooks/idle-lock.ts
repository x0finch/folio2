// Shared by the live timer and the on-return check. A clock that went backwards
// (now < lastActiveAt) never locks: the threat is a casual glance, not worth a false lock.

export const IDLE_TIMEOUT_MINUTES = [1, 5, 15, 30] as const;

/** Value is "1" | "5" | "15" | "30". */
export const IDLE_TIMEOUT_STORAGE_KEY = "folio_lock_timeout";

/** Only "how long if enabled"; on/off is the separate IDLE_LOCK_ENABLED_KEY. */
export const DEFAULT_IDLE_TIMEOUT_RAW = "15";

/**
 * On/off switch (non-empty = on), kept separate from the duration so turning it off and on
 * again keeps the chosen minutes. Enabling always re-verifies the passkey, even if
 * LOCK_DEVICE_PASSKEY_KEY is already set.
 */
export const IDLE_LOCK_ENABLED_KEY = "folio_lock_enabled";

/**
 * WebAuthn credentialID of this device's platform passkey. Does not decide locking (only
 * IDLE_LOCK_ENABLED_KEY does); it marks "this device" in the passkey list and tells whether a
 * deleted passkey was this device's. Stores the credentialID, not the DB row id, because the
 * verify path only gets the credentialID (assertion `response.id`); deletion still takes row.id.
 * Per-device because the web cannot probe whether a device holds a passkey for an account.
 * Not a security boundary: tampering only skews hints; unlock is enforced by WebAuthn.
 */
export const LOCK_DEVICE_PASSKEY_KEY = "folio_lock_device_passkey";

export function shouldLock(opts: {
  lastActiveAt: number;
  now: number;
  timeoutMs: number | null;
}): boolean {
  if (opts.timeoutMs === null) return false;
  const elapsed = opts.now - opts.lastActiveAt;
  if (elapsed < 0) return false;
  return elapsed >= opts.timeoutMs;
}

// Missing / invalid / legacy "never" fall back to the default; a legacy "never" user has no
// enabled key, so they still don't lock.
export function parseIdleTimeout(raw: string | null): number {
  const n = Number(raw);
  return (IDLE_TIMEOUT_MINUTES as readonly number[]).includes(n)
    ? n * 60_000
    : Number(DEFAULT_IDLE_TIMEOUT_RAW) * 60_000;
}
