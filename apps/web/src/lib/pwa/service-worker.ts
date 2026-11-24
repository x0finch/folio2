import { toast } from "@folio/ui";
import { useEffect, useSyncExternalStore } from "react";
import { useTranslations } from "use-intl";
import { isNewerVersion, parseSwBuild, RUNNING_VERSION, stripBuildHash } from "./version";

// Browsers don't re-check on their own, so long sessions would never see a new release.
const UPDATE_POLL_MS = 30 * 60 * 1000;
// Fixed id so multiple sources collapse into one toast.
export const UPDATE_TOAST_ID = "sw-update";
// Keeps the "updating" splash visible; skipWaiting is otherwise too fast to read.
const UPDATING_MIN_MS = 600;

// Navigation is network-first (public/sw.js), so a cold start is already current; only a
// long-open session can fall behind. Staleness is a version-string compare, not SW waiting state.

let updating = false;
const updatingListeners = new Set<() => void>();

// Holds the version (not a boolean) so each version is prompted only once.
let availableVersion: string | null = null;
const availableListeners = new Set<() => void>();

let registration: ServiceWorkerRegistration | null = null;
let lastPromptedVersion: string | null = null;
let reloading = false;

function beginUpdating(): void {
  if (updating) return;
  updating = true;
  for (const notify of updatingListeners) notify();
}

function setAvailable(version: string | null): void {
  if (availableVersion === version) return;
  availableVersion = version;
  for (const notify of availableListeners) notify();
}

/**
 * The unique query param busts the Cloudflare edge cache: `cache: "no-store"` only skips the
 * browser cache, and the edge caches the unhashed /sw.js, so updates would never be detected.
 */
async function fetchDeployedVersion(): Promise<string | null> {
  try {
    const res = await fetch(`/sw.js?_=${Date.now()}`, { cache: "no-store" });
    if (!res.ok) return null;
    return parseSwBuild(await res.text());
  } catch {
    return null;
  }
}

function applyUpdate(): void {
  if (reloading) return;
  beginUpdating();
  setTimeout(() => {
    const waiting = registration?.waiting;
    if (waiting) {
      waiting.postMessage({ type: "SKIP_WAITING" });
    } else {
      reloading = true;
      window.location.reload();
    }
  }, UPDATING_MIN_MS);
}

/** Also kicks registration.update() so the new SW is already waiting when the user applies it. */
export async function checkForUpdate(): Promise<boolean> {
  const deployed = await fetchDeployedVersion();
  const newer = isNewerVersion(deployed, RUNNING_VERSION);
  if (newer) {
    setAvailable(deployed);
    registration?.update().catch(() => {});
  }
  return newer;
}

export function registerServiceWorker(): () => void {
  if (!import.meta.env.PROD) return () => {};
  if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) return () => {};

  // Fires only after our own SKIP_WAITING (first install doesn't swap controller).
  const onControllerChange = () => {
    if (reloading) return;
    reloading = true;
    window.location.reload();
  };
  navigator.serviceWorker.addEventListener("controllerchange", onControllerChange);

  const poll = setInterval(() => void checkForUpdate(), UPDATE_POLL_MS);
  const onVisible = () => {
    if (document.visibilityState === "visible") void checkForUpdate();
  };
  document.addEventListener("visibilitychange", onVisible);

  // updateViaCache: none — update checks bypass the HTTP cache.
  navigator.serviceWorker
    .register("/sw.js", { type: "module", updateViaCache: "none" })
    .then((reg) => {
      registration = reg;
    })
    .catch(() => {
      // Registration failure must not surface in the UI.
    });

  return () => {
    navigator.serviceWorker.removeEventListener("controllerchange", onControllerChange);
    clearInterval(poll);
    document.removeEventListener("visibilitychange", onVisible);
  };
}

export function useSplashUpdating(): boolean {
  return useSyncExternalStore(
    (cb) => {
      updatingListeners.add(cb);
      return () => updatingListeners.delete(cb);
    },
    () => updating,
    () => false,
  );
}

/** Persistent toast; the fixed id plus this single constructor keep it to one across sources. */
export function showUpdateToast(labels: { available: string; update: string }): void {
  lastPromptedVersion = availableVersion;
  toast.message(labels.available, {
    id: UPDATE_TOAST_ID,
    duration: 0, // 0 = persistent (toast-store convention)
    description: availableVersion ? stripBuildHash(availableVersion) : undefined,
    action: { label: labels.update, onClick: () => applyUpdate() },
  });
}

/** Prompts once per version. Mount once (in RootDocument). */
export function useUpdateToast(): void {
  const t = useTranslations("Update");
  useEffect(() => {
    const maybePrompt = () => {
      if (!availableVersion || availableVersion === lastPromptedVersion) return;
      showUpdateToast({ available: t("available"), update: t("update") });
    };
    availableListeners.add(maybePrompt);
    maybePrompt(); // catch a version found before subscribing
    return () => {
      availableListeners.delete(maybePrompt);
    };
  }, [t]);
}
