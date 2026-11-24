import { useCallback, useEffect, useRef, useState } from "react";
import { shouldLock } from "./idle-lock";

// visibilitychange / pageshow / focus re-check expiry because background tabs throttle or
// suspend timers. Last-active lives in localStorage so a reload can't bypass the lock.
// Locking syncs across tabs (so opening the URL in a new tab is still locked); unlocking does not.

const LAST_ACTIVE_KEY = "folio_lock_last_active";
// Value is a timestamp so every write differs and always fires a storage event.
const LOCK_FLAG_KEY = "folio_lock_locked";
const ACTIVITY_EVENTS = [
  "mousemove",
  "keydown",
  "pointerdown",
  "touchstart",
  "scroll",
  "wheel",
] as const;
// 5s precision is plenty for minute-level timeouts.
const ACTIVITY_THROTTLE_MS = 5000;

function readLastActive(): number {
  try {
    const v = localStorage.getItem(LAST_ACTIVE_KEY);
    return v ? Number(v) : Date.now();
  } catch {
    return Date.now();
  }
}

function writeLastActive(t: number): void {
  try {
    localStorage.setItem(LAST_ACTIVE_KEY, String(t));
  } catch {
    // Storage unavailable: falls back to an in-memory timer that a reload resets.
  }
}

// Also read by the route guard: while locked, the persisted query cache is not restored.
export function readLockFlag(): boolean {
  try {
    return localStorage.getItem(LOCK_FLAG_KEY) != null;
  } catch {
    return false;
  }
}
function writeLockFlag(): void {
  try {
    localStorage.setItem(LOCK_FLAG_KEY, String(Date.now()));
  } catch {
    // Storage unavailable: lock stays tab-local.
  }
}
function clearLockFlag(): void {
  try {
    localStorage.removeItem(LOCK_FLAG_KEY);
  } catch {}
}

// Sign-out must call this: a stale lock flag or last-active would lock the next sign-in on mount.
export function clearIdleLockState(): void {
  try {
    localStorage.removeItem(LOCK_FLAG_KEY);
    localStorage.removeItem(LAST_ACTIVE_KEY);
  } catch {}
}

export function useIdleLock(timeoutMs: number | null): { locked: boolean; unlock: () => void } {
  // Initialised from the shared flag so a new tab opened while locked never flashes content.
  const [locked, setLocked] = useState(readLockFlag);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastWrite = useRef(0);
  const timeoutRef = useRef(timeoutMs);
  timeoutRef.current = timeoutMs;
  const lockedRef = useRef(locked);
  lockedRef.current = locked;

  const lock = useCallback(() => {
    if (lockedRef.current) return;
    lockedRef.current = true;
    writeLockFlag();
    setLocked(true);
  }, []);

  // On mount baseTime is the persisted lastActiveAt, so a reload continues the remaining time
  // instead of restarting a full round.
  const armTimer = useCallback(
    (baseTime: number) => {
      if (timer.current) clearTimeout(timer.current);
      timer.current = null;
      const t = timeoutRef.current;
      if (t === null) return;
      const remaining = t - (Date.now() - baseTime);
      if (remaining <= 0) {
        lock();
        return;
      }
      timer.current = setTimeout(lock, remaining);
    },
    [lock],
  );

  const checkExpiry = useCallback(() => {
    if (
      shouldLock({ lastActiveAt: readLastActive(), now: Date.now(), timeoutMs: timeoutRef.current })
    ) {
      lock();
    }
  }, [lock]);

  const unlock = useCallback(() => {
    const now = Date.now();
    writeLastActive(now);
    lastWrite.current = now;
    clearLockFlag();
    setLocked(false);
    armTimer(now);
  }, [armTimer]);

  useEffect(() => {
    checkExpiry();
    armTimer(readLastActive());

    const onActivity = () => {
      const now = Date.now();
      // Check expiry before refreshing: scroll restoration on reload fires a scroll event that
      // would otherwise overwrite an expired timestamp and bypass the lock.
      if (shouldLock({ lastActiveAt: readLastActive(), now, timeoutMs: timeoutRef.current })) {
        lock();
        return;
      }
      if (locked) return;
      if (now - lastWrite.current >= ACTIVITY_THROTTLE_MS) {
        writeLastActive(now);
        lastWrite.current = now;
      }
      armTimer(now);
    };
    const onVisible = () => {
      if (document.visibilityState === "visible") checkExpiry();
    };
    const onStorage = (e: StorageEvent) => {
      // Follow another tab's lock without writing back (no loop); its unlock is not followed.
      if (e.key === LOCK_FLAG_KEY && e.newValue != null) {
        setLocked(true);
        return;
      }
      // Activity in another tab moves the shared lastActive; re-arm so this tab doesn't lock early.
      if (e.key === LAST_ACTIVE_KEY && e.newValue != null && !lockedRef.current) {
        armTimer(Number(e.newValue));
      }
    };

    for (const e of ACTIVITY_EVENTS) window.addEventListener(e, onActivity, { passive: true });
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("pageshow", checkExpiry);
    window.addEventListener("focus", checkExpiry);
    window.addEventListener("storage", onStorage);
    return () => {
      if (timer.current) clearTimeout(timer.current);
      for (const e of ACTIVITY_EVENTS) window.removeEventListener(e, onActivity);
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("pageshow", checkExpiry);
      window.removeEventListener("focus", checkExpiry);
      window.removeEventListener("storage", onStorage);
    };
  }, [locked, armTimer, checkExpiry, lock]);

  useEffect(() => {
    if (locked) return;
    if (timeoutMs === null) {
      if (timer.current) clearTimeout(timer.current);
      timer.current = null;
      return;
    }
    armTimer(readLastActive());
  }, [timeoutMs, locked, armTimer]);

  return { locked, unlock };
}
