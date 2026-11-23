import { useCallback, useEffect, useState } from "react";
import { LOCK_DEVICE_PASSKEY_KEY } from "./idle-lock";

// `storage` events only fire in other tabs; this event notifies the same tab.
const LOCK_DEVICE_EVENT = "folio:lock-device-change";

function read(): string | null {
  try {
    return localStorage.getItem(LOCK_DEVICE_PASSKEY_KEY);
  } catch {
    return null;
  }
}

// Display-only: a missing or stale value never changes whether the app locks.
// Always null during render so the first frame matches SSR.
export function useLockDevice(): {
  credentialId: string | null;
  ready: boolean;
  markReady: (credentialId: string) => void;
  clearReady: () => void;
} {
  const [credentialId, setCredentialId] = useState<string | null>(null);

  useEffect(() => {
    const sync = () => setCredentialId(read());
    sync();
    // key === null means storage was cleared.
    const onStorage = (e: StorageEvent) => {
      if (e.key === LOCK_DEVICE_PASSKEY_KEY || e.key === null) sync();
    };
    window.addEventListener(LOCK_DEVICE_EVENT, sync);
    window.addEventListener("storage", onStorage);
    return () => {
      window.removeEventListener(LOCK_DEVICE_EVENT, sync);
      window.removeEventListener("storage", onStorage);
    };
  }, []);

  // Call only after this device's credential was proven (platform registration or a verify).
  const markReady = useCallback((id: string) => {
    try {
      localStorage.setItem(LOCK_DEVICE_PASSKEY_KEY, id);
    } catch {
      // Storage unavailable: in-memory only for this session.
    }
    setCredentialId(id);
    window.dispatchEvent(new Event(LOCK_DEVICE_EVENT));
  }, []);

  const clearReady = useCallback(() => {
    try {
      localStorage.removeItem(LOCK_DEVICE_PASSKEY_KEY);
    } catch {}
    setCredentialId(null);
    window.dispatchEvent(new Event(LOCK_DEVICE_EVENT));
  }, []);

  return { credentialId, ready: credentialId != null, markReady, clearReady };
}
