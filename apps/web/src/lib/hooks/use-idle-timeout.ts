import { useCallback, useEffect, useState } from "react";
import {
  DEFAULT_IDLE_TIMEOUT_RAW,
  IDLE_LOCK_ENABLED_KEY,
  IDLE_TIMEOUT_STORAGE_KEY,
  parseIdleTimeout,
} from "./idle-lock";

// `storage` events only fire in other tabs; this event notifies the same tab.
const IDLE_TIMEOUT_EVENT = "folio:idle-timeout-change";

function readRaw(): string {
  try {
    return localStorage.getItem(IDLE_TIMEOUT_STORAGE_KEY) ?? DEFAULT_IDLE_TIMEOUT_RAW;
  } catch {
    return DEFAULT_IDLE_TIMEOUT_RAW;
  }
}

function readEnabled(): boolean {
  try {
    return localStorage.getItem(IDLE_LOCK_ENABLED_KEY) != null;
  } catch {
    return false;
  }
}

// Per-device preference. First frame uses defaults (off) to match SSR; real values load on mount.
export function useIdleTimeout(): {
  raw: string;
  timeoutMs: number;
  enabled: boolean;
  setRaw: (next: string) => void;
  setEnabled: (next: boolean) => void;
} {
  const [raw, setRawState] = useState(DEFAULT_IDLE_TIMEOUT_RAW);
  const [enabled, setEnabledState] = useState(false);

  useEffect(() => {
    const sync = () => {
      setRawState(readRaw());
      setEnabledState(readEnabled());
    };
    sync();
    // key === null means storage was cleared.
    const onStorage = (e: StorageEvent) => {
      if (e.key === IDLE_TIMEOUT_STORAGE_KEY || e.key === IDLE_LOCK_ENABLED_KEY || e.key === null) {
        sync();
      }
    };
    window.addEventListener(IDLE_TIMEOUT_EVENT, sync);
    window.addEventListener("storage", onStorage);
    return () => {
      window.removeEventListener(IDLE_TIMEOUT_EVENT, sync);
      window.removeEventListener("storage", onStorage);
    };
  }, []);

  const setRaw = useCallback((next: string) => {
    try {
      localStorage.setItem(IDLE_TIMEOUT_STORAGE_KEY, next);
    } catch {
      // Storage unavailable: in-memory only.
    }
    setRawState(next);
    window.dispatchEvent(new Event(IDLE_TIMEOUT_EVENT));
  }, []);

  // Turning off keeps the duration and the device passkey record.
  const setEnabled = useCallback((next: boolean) => {
    try {
      if (next) localStorage.setItem(IDLE_LOCK_ENABLED_KEY, "1");
      else localStorage.removeItem(IDLE_LOCK_ENABLED_KEY);
    } catch {}
    setEnabledState(next);
    window.dispatchEvent(new Event(IDLE_TIMEOUT_EVENT));
  }, []);

  return { raw, timeoutMs: parseIdleTimeout(raw), enabled, setRaw, setEnabled };
}
