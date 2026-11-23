import { useSyncExternalStore } from "react";

// Per-browser preference in localStorage (the HTML shell is static, so cookies can't shape it).
// `useSyncExternalStore` with `serverValue` makes hydration match the shell, then swaps in the
// real value. Storage errors read as `parse(null)` and drop writes.
export function storedPreference<T extends string>(
  key: string,
  parse: (raw: string | null) => T,
  serverValue: T,
) {
  const listeners = new Set<() => void>();

  function read(): T {
    let raw: string | null = null;
    try {
      raw = localStorage.getItem(key);
    } catch {}
    return parse(raw);
  }

  function write(next: string): void {
    try {
      localStorage.setItem(key, parse(next));
    } catch {}
    for (const notify of listeners) notify();
  }

  function subscribe(notify: () => void): () => void {
    listeners.add(notify);
    // key === null means storage was cleared.
    const onStorage = (e: StorageEvent) => {
      if (e.key === key || e.key === null) notify();
    };
    window.addEventListener("storage", onStorage);
    return () => {
      listeners.delete(notify);
      window.removeEventListener("storage", onStorage);
    };
  }

  function useValue(): T {
    return useSyncExternalStore(subscribe, read, () => serverValue);
  }

  return { read, write, useValue };
}
